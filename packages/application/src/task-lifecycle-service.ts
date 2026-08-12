// @slice-activation P4 W2 is composed by tests; W3 owns daemon and production publication cutover.
import { Effect } from "effect";
import { applyTransition, canonicalizeContractValue, taskLifecycleWritePlan, validateTaskLifecycleCommandEnvelope,
  type FrozenWritePlan, type ProofFor, type TaskEventV1, type TaskLifecycleCommand, type TaskLifecycleSnapshot,
  type WriteError, type WriteOperationReceipt, type WriteTarget } from "../../kernel/src/index.ts";

export async function runTaskLifecycleEffect<A>(effect: Effect.Effect<A, WriteError>): Promise<A> { const result = await Effect.runPromise(Effect.either(effect)); if (result._tag === "Left") throw result.left; return result.right; }
export class TaskLifecycleOperationConflict extends Error {
  readonly code: string;
  constructor(message: string, code = "service_rejected") { super(message); this.name = "TaskLifecycleOperationConflict"; this.code = code; }
}
export type TaskLifecycleKillpoint = "after_sqlite_commit" | "before_response_write" | "after_response_write";
export interface TaskLifecycleServiceRead { readonly status: "ready" | "pending"; readonly snapshot: TaskLifecycleSnapshot; readonly watermark: number; readonly sourceRevision: number; readonly warnings: readonly string[] }
interface EventStorePort { readonly readEvent: (opId: string) => TaskEventV1 | null; readonly append: (event: TaskEventV1) => { readonly status: "applied"; readonly event: TaskEventV1; readonly revision: number } }
type Lease = NonNullable<TaskLifecycleSnapshot["lease"]>;
interface ProjectionPort {
  readonly apply: (event: TaskEventV1) => { readonly metrics: { readonly reducedItems: number } }; readonly read: (taskId: string) => TaskLifecycleServiceRead;
  readonly readOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null; readonly currentLease: (taskId: string, now?: string) => Lease | null;
  readonly reserveLease: (lease: Lease, now: string) => Lease; readonly activateLease: (lease: Lease) => Lease;
  readonly renewLease: (lease: Lease, expiresAt: string) => Lease; readonly releaseLease: (lease: Lease) => Lease;
}
type StartCommand = Extract<TaskLifecycleCommand, { readonly type: "StartExecution" }>;
type RequestedReservation = Pick<Lease, "taskId" | "executionId" | "expiresAt" | "ttlMs"> & Partial<Pick<ProofFor<StartCommand>["reservation"], "previousHolder" | "reason" | "version">>;
export type TaskLifecycleServiceProof<C extends TaskLifecycleCommand> = C extends StartCommand ? { readonly actorBinding: C["actor"]; readonly reservation: RequestedReservation } : ProofFor<C>;
export interface TaskLeaseRenewInput {
  readonly taskId: string; readonly executionId: string; readonly actor: TaskLifecycleCommand["actor"]; readonly source: TaskLifecycleCommand["source"]; readonly expectedVersion: number; readonly expiresAt: string; readonly opId: string; readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string;
}
export interface TaskLifecycleService { readonly execute: <C extends TaskLifecycleCommand>(command: C, proof: TaskLifecycleServiceProof<C>) => Promise<WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]>>; readonly read: (taskId: string) => Promise<TaskLifecycleServiceRead>; readonly renewLease: (input: TaskLeaseRenewInput) => Promise<Lease> }

export function makeTaskLifecycleService(options: { readonly eventStore: EventStorePort; readonly projection: ProjectionPort; readonly killpoint?: (point: TaskLifecycleKillpoint) => void }): TaskLifecycleService {
  const read = async (taskId: string) => options.projection.read(taskId);
  return { read, renewLease: async (input) => renewTaskLease(options, read, input), execute: async <C extends TaskLifecycleCommand>(command: C, proof: TaskLifecycleServiceProof<C>) => {
    const issues = validateTaskLifecycleCommandEnvelope(command);
    if (issues.length > 0) throw new TaskLifecycleOperationConflict(`invalid normalized command envelope: ${issues.map((issue) => issue.message).join("; ")}`);
    const plan = taskLifecycleWritePlan(command), existing = options.eventStore.readEvent(command.opId);
    if (existing !== null) {
      if (!eventMatchesOperation(existing, command, proof as ProofFor<C>)) throw new TaskLifecycleOperationConflict(`opId ${command.opId} already has a different payload`);
      if (options.projection.readOperation(command.opId) === null) options.projection.apply(existing);
      return receiptFromRead(await read(command.taskId), existing, plan);
    }
    const current = await read(command.taskId);
    if (current.status !== "ready" && (command.type !== "CreateReplayTask" || current.snapshot.task !== null)) return pendingReceipt(current, plan, command.opId, "projection catch-up is pending");
    const claim = command.type === "StartExecution" ? reserveClaim(options.projection, command, proof as TaskLifecycleServiceProof<StartCommand>) : null;
    const event = applyTransition(current.snapshot, command, (claim?.proof ?? proof) as ProofFor<C>).event;
    try { plannedPublication(plan, event, () => options.eventStore.append(event)); }
    catch (error) { if (claim !== null) releaseReservation(options.projection, claim.reserving); throw error; }
    if (claim !== null) try {
      const active = options.projection.activateLease(claim.reserving);
      if (json(active) !== json(claim.active)) throw new TaskLifecycleOperationConflict("lease activation did not match the L1 event");
    } catch (error) { return pendingReceipt(current, plan, command.opId, message(error), event); }
    let applied;
    try { applied = planned(plan, projectionTarget(command.taskId), () => options.projection.apply(event)); }
    catch (error) { return pendingReceipt(await read(command.taskId), plan, command.opId, message(error), event); }
    if (applied.metrics.reducedItems === 0) return pendingReceipt({ ...current, sourceRevision: event.workspaceRevision }, plan, command.opId, "projection catch-up is pending", event);
    options.killpoint?.("after_sqlite_commit"); options.killpoint?.("before_response_write");
    const receipt = receiptFromRead(await read(command.taskId), event, plan); options.killpoint?.("after_response_write"); return receipt;
  } };
}

async function renewTaskLease(options: { readonly eventStore: EventStorePort; readonly projection: ProjectionPort }, read: (taskId: string) => Promise<TaskLifecycleServiceRead>, input: TaskLeaseRenewInput): Promise<Lease> {
  const existing = options.eventStore.readEvent(input.opId);
  if (existing !== null) {
    if (!matchesRenewal(existing, input)) throw new TaskLifecycleOperationConflict(`opId ${input.opId} already has a different payload`);
    if (options.projection.readOperation(input.opId) === null) options.projection.apply(existing);
    const replayed = options.projection.currentLease(input.taskId); if (replayed === null) throw new TaskLifecycleOperationConflict(`renewed lease ${input.opId} is not readable`); return replayed;
  }
  const current = options.projection.currentLease(input.taskId, input.occurredAt);
  if (current === null || current.phase !== "active" || current.executionId !== input.executionId || !sameActor(current.actor, input.actor)
    || json(current.source) !== json(input.source) || current.version !== input.expectedVersion) throw new TaskLifecycleOperationConflict(`stale lease CAS for task ${input.taskId}`);
  const state = await read(input.taskId), task = state.snapshot.task, execution = state.snapshot.executions.find((candidate) => candidate.executionId === input.executionId);
  if (state.status !== "ready" || task === null || execution === undefined) throw new TaskLifecycleOperationConflict("lease renewal requires a ready active execution");
  const renewed = { ...current, expiresAt: input.expiresAt, version: current.version + 1 };
  const event: Extract<TaskEventV1, { readonly type: "lease_renewed" }> = { schema: "task-event/v1", eventId: input.eventId, workspaceRevision: input.workspaceRevision,
    opId: input.opId, taskId: input.taskId, type: "lease_renewed", actor: input.actor, source: input.source, occurredAt: input.occurredAt,
    payload: { task, execution, lease: renewed, previousHolder: holder(current), leaseExpiresAt: renewed.expiresAt, reason: "same_principal_reconnect" } };
  options.eventStore.append(event); const changed = options.projection.renewLease(current, input.expiresAt);
  if (json(changed) !== json(renewed)) throw new TaskLifecycleOperationConflict("lease renewal CAS did not match the L1 event");
  options.projection.apply(event); return changed;
}

function reserveClaim(projection: ProjectionPort, command: StartCommand, proof: TaskLifecycleServiceProof<StartCommand>): { readonly reserving: Lease; readonly active: Lease; readonly proof: ProofFor<StartCommand> } {
  const previous = projection.currentLease(command.taskId, command.occurredAt);
  if (previous?.phase === "active" || previous?.phase === "reserving") throw new TaskLifecycleOperationConflict("the current round already has an active execution or lease", "invalid_transition");
  const reserving = projection.reserveLease({ schema: "lease/v1", taskId: command.taskId, executionId: command.executionId, actor: command.actor, source: command.source,
    phase: "reserving", expiresAt: proof.reservation.expiresAt, ttlMs: proof.reservation.ttlMs, version: previous === null ? 0 : previous.version + 1 }, command.occurredAt);
  const active = { ...reserving, phase: "active" as const, version: reserving.version + 1 }, previousHolder = previous === null ? null : holder(previous);
  const reason = previous === null ? "initial_claim" as const : sameActor(previous.actor, command.actor) ? "same_principal_reconnect" as const : "ttl_expired_takeover" as const;
  return { reserving, active, proof: { actorBinding: proof.actorBinding, reservation: { taskId: active.taskId, executionId: active.executionId,
    expiresAt: active.expiresAt, ttlMs: active.ttlMs, previousHolder, reason, version: active.version } } };
}
function releaseReservation(projection: ProjectionPort, reservation: Lease): void { try { projection.releaseLease(reservation); } catch (error) { consumeKnownError(error); } }
function consumeKnownError(error: unknown): void { void error; }
function holder(lease: Lease): Pick<Lease, "taskId" | "executionId" | "actor" | "source"> { return { taskId: lease.taskId, executionId: lease.executionId, actor: lease.actor, source: lease.source }; }
function matchesRenewal(event: TaskEventV1, input: TaskLeaseRenewInput): boolean { return event.type === "lease_renewed" && event.taskId === input.taskId
  && event.payload.execution.executionId === input.executionId && event.payload.lease.version === input.expectedVersion + 1 && event.payload.lease.expiresAt === input.expiresAt
  && sameActor(event.actor, input.actor) && json(event.source) === json(input.source); }
function sameActor(left: TaskLifecycleCommand["actor"], right: TaskLifecycleCommand["actor"]): boolean { return left.principal.personId === right.principal.personId && left.executor?.kind === right.executor?.kind && left.executor?.id === right.executor?.id; }
function eventTargets(opId: string): readonly [WriteTarget, WriteTarget] { return [{ kind: "event_file", path: `harness/events/${opId}.json`, operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }]; }
function projectionTarget(taskId: string): WriteTarget { return { kind: "projection_invalidation", projection: "task-lifecycle/v1", taskId }; }
function plannedPublication<A>(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, event: TaskEventV1, write: () => A): A { for (const target of eventTargets(event.opId)) assertWriteTargetDeclared(plan, target); return write(); }
function planned<A>(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, target: WriteTarget, write: () => A): A { assertWriteTargetDeclared(plan, target); return write(); }
export function assertWriteTargetDeclared(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, target: WriteTarget): void {
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.targets) || !plan.targets.some((candidate) => json(candidate) === json(target))) throw new TaskLifecycleOperationConflict(`undeclared_write_target: ${json(target)}`);
}
function receiptFromRead(read: TaskLifecycleServiceRead, event: TaskEventV1, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  return read.status === "ready" && read.watermark >= event.workspaceRevision ? { outcome: "applied", opId: event.opId, event, revision: event.workspaceRevision,
    evidence: `event-file:${event.opId}`, visibility: "center", proof: { committedRevision: event.workspaceRevision, appliedCut: event.workspaceRevision }, snapshot: read.snapshot, frozenPlan: plan }
    : pendingReceipt(read, plan, event.opId, "projection catch-up is pending", event);
}
function pendingReceipt(read: TaskLifecycleServiceRead, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, opId: string, reason: string, event?: TaskEventV1): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  const revision = event?.workspaceRevision ?? read.sourceRevision; return { outcome: "pending", opId, ...(event ? { event } : {}), revision, evidence: `event-file:${opId}`,
    visibility: "center", proof: { committedRevision: revision, appliedCut: read.watermark }, snapshot: read.snapshot, frozenPlan: plan, nextAction: `retry task lifecycle read: ${reason}` };
}
function eventMatchesOperation<C extends TaskLifecycleCommand>(event: TaskEventV1, command: C, proof: ProofFor<C>): boolean { return json(operationIdentityFromEvent(event)) === json(operationIdentityFromCommand(command, proof)); }
function operationIdentityFromCommand<C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>): unknown {
  const common = { type: command.type, taskId: command.taskId, eventId: command.eventId, workspaceRevision: command.workspaceRevision, actor: command.actor, source: command.source, occurredAt: command.occurredAt };
  if (command.type === "CreateReplayTask") return { ...common, title: command.title, graph: command.graph, completionGateIds: command.completionGateIds };
  if (command.type === "StartExecution" || command.type === "CompleteTask") return { ...common, executionId: command.executionId };
  if (command.type === "SubmitExecution") return { ...common, executionId: command.executionId, submission: command.submission };
  return { ...common, executionId: command.executionId, reviewId: command.reviewId, kind: command.kind, verdict: command.verdict, actorRole: command.actorRole, reason: command.reason,
    evidenceChecked: command.evidenceChecked, commitSha: command.commitSha, iteration: command.iteration, archiveWarningsAcknowledged: command.archiveWarningsAcknowledged, capabilityRef: (proof as { readonly capabilityRef: string }).capabilityRef };
}
function operationIdentityFromEvent(event: TaskEventV1): unknown {
  const type = event.type === "task_created" ? "CreateReplayTask" : event.type === "execution_started" ? "StartExecution" : event.type === "lease_renewed" ? "RenewLease"
    : event.type === "execution_submitted" ? "SubmitExecution" : event.type === "task_completed" ? "CompleteTask" : "RecordReview";
  const common = { type, taskId: event.taskId, eventId: event.eventId, workspaceRevision: event.workspaceRevision, actor: event.actor, source: event.source, occurredAt: event.occurredAt };
  if (event.type === "task_created") return { ...common, title: event.payload.task.title, graph: event.payload.task.graph, completionGateIds: event.payload.task.completionGateIds };
  if (event.type === "execution_started" || event.type === "task_completed") return { ...common, executionId: event.payload.execution.executionId };
  if (event.type === "lease_renewed") return { ...common, executionId: event.payload.execution.executionId, expiresAt: event.payload.lease.expiresAt };
  if (event.type === "execution_submitted") return { ...common, executionId: event.payload.execution.executionId, submission: event.payload.execution.submission };
  const review = event.payload.review; return { ...common, executionId: review.executionId, reviewId: review.reviewId, kind: review.kind, verdict: review.verdict,
    actorRole: review.actorRole, reason: review.reason, evidenceChecked: review.evidenceChecked, commitSha: review.commitSha, iteration: review.iteration,
    archiveWarningsAcknowledged: review.archiveWarningsAcknowledged, capabilityRef: review.capabilityRef };
}
function json(value: unknown): string { return JSON.stringify(canonicalizeContractValue(value)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
