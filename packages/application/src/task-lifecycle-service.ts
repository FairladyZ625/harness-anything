// @slice-activation P4 W2 exposes replay/v1 domain transactions for the W3 CLI composition root.
import { Effect } from "effect";
import {
  applyTransition,
  canonicalizeContractValue,
  freezeWritePlan,
  taskLifecycleWritePlan,
  type FrozenWritePlan,
  type LeaseV1,
  type ProofFor,
  type StartExecutionProof,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot,
  type WriteOperationReceipt,
  type WriteTarget,
  type WriteError
} from "../../kernel/src/index.ts";
export async function runTaskLifecycleEffect<A>(effect: Effect.Effect<A, WriteError>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") throw result.left;
  return result.right;
}
export class TaskLifecycleOperationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLifecycleOperationConflict";
  }
}
export type TaskLifecycleKillpoint = "after_reservation" | "after_event_append" | "before_projection_apply" | "after_projection_apply" | "before_lease_finalize";
export interface TaskLifecycleServiceRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}
interface EventStorePort {
  readonly read: () => { readonly revision: number; readonly events: readonly TaskEventV1[] };
  readonly append: (event: TaskEventV1) => Effect.Effect<
    | { readonly status: "applied"; readonly event: TaskEventV1; readonly revision: number }
    | { readonly status: "indeterminate"; readonly reason: string; readonly query: string }, never
  >;
}
interface ProjectionPort {
  readonly apply: (event: TaskEventV1) => void;
  readonly read: (taskId: string) => TaskLifecycleServiceRead;
}
interface LeasePort {
  readonly current: (taskId: string) => LeaseV1 | null;
  readonly reserve: (input: { readonly taskId: string; readonly executionId: string; readonly actor: TaskLifecycleCommand["actor"];
    readonly source: TaskLifecycleCommand["source"]; readonly expiresAt: string; readonly ttlMs: number }) => Promise<LeaseV1>;
  readonly activate: (input: LeaseCas) => Promise<LeaseV1>;
  readonly release: (input: LeaseCas) => Promise<LeaseV1>;
}
interface LeaseCas { readonly taskId: string; readonly executionId: string; readonly actor: TaskLifecycleCommand["actor"]; readonly source: TaskLifecycleCommand["source"]; readonly version: number }
export interface TaskLifecycleService {
  readonly execute: <C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>) => Promise<WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]>>;
  readonly read: (taskId: string) => Promise<TaskLifecycleServiceRead>;
}
export function makeTaskLifecycleService(options: {
  readonly eventStore: EventStorePort;
  readonly projection: ProjectionPort;
  readonly leases: LeasePort;
  readonly killpoint?: (point: TaskLifecycleKillpoint) => void;
}): TaskLifecycleService {
  const read = (taskId: string) => readAndConverge(options.projection, options.leases, taskId, recoveryWritePlan(taskId));
  return {
    read,
    execute: async <C extends TaskLifecycleCommand>(command: C, suppliedProof: ProofFor<C>) => {
      const plan = taskLifecycleWritePlan(command);
      const existing = options.eventStore.read().events.find((event) => event.opId === command.opId);
      if (existing !== undefined) {
        if (!eventMatchesOperation(existing, command, suppliedProof)) throw new TaskLifecycleOperationConflict(`opId ${command.opId} already has a different payload`);
        return receiptFromRead(await read(command.taskId), existing, plan);
      }
      const current = await readAndConverge(options.projection, options.leases, command.taskId, recoveryWritePlan(command.taskId));
      if (current.status !== "ready") return pendingReceipt(current, plan, command.opId, "projection catch-up is pending");
      if (command.type === "StartExecution") applyTransition(current.snapshot, command, suppliedProof);
      let proof = suppliedProof;
      let reservation: LeaseV1 | null = null;
      let event: TaskEventV1 | undefined;
      try {
        if (command.type === "StartExecution") {
          const startProof = suppliedProof as StartExecutionProof;
          reservation = await planned(plan, leaseTarget(command.taskId, "reserve"), () => options.leases.reserve({
            taskId: command.taskId,
            executionId: command.executionId,
            actor: command.actor,
            source: command.source,
            expiresAt: startProof.reservation.expiresAt,
            ttlMs: startProof.reservation.ttlMs
          }));
          proof = { ...startProof, reservation: { ...startProof.reservation, version: reservation.version } } as ProofFor<C>;
          options.killpoint?.("after_reservation");
        }
        const snapshot = { ...current.snapshot, lease: command.type === "StartExecution" ? null : options.leases.current(command.taskId) };
        const transition = applyTransition(snapshot, command, proof);
        event = transition.event;
        const publication = await planned(plan, eventTarget(), () => runTaskLifecycleEffect(options.eventStore.append(event!)));
        if (publication.status === "indeterminate") {
          await releaseReservation(options.leases, reservation, plan);
          return indeterminateReceipt(current, plan, command.opId, publication.reason, publication.query);
        }
        event = publication.event;
        options.killpoint?.("after_event_append");
        options.killpoint?.("before_projection_apply");
        try {
          planned(plan, projectionTarget(command.taskId), () => options.projection.apply(event!));
        } catch (error) {
          return pendingReceipt(await read(command.taskId), plan, command.opId, errorMessage(error), event);
        }
        options.killpoint?.("after_projection_apply");
        options.killpoint?.("before_lease_finalize");
        try {
          await finalizeLease(options.leases, command, reservation, plan);
        } catch (error) {
          return pendingReceipt(await read(command.taskId), plan, command.opId, errorMessage(error), event);
        }
        return receiptFromRead(await read(command.taskId), event, plan);
      } catch (error) {
        if (event === undefined) {
          await releaseReservation(options.leases, reservation, plan);
          throw error;
        }
        const stream = options.eventStore.read();
        if (!stream.events.some((candidate) => candidate.opId === event?.opId)) {
          await releaseReservation(options.leases, reservation, plan);
          if (stream.events.some((candidate) => candidate.workspaceRevision === event?.workspaceRevision)) {
            throw new TaskLifecycleOperationConflict(`workspace revision ${event.workspaceRevision} was accepted by another operation`);
          }
          throw error;
        }
        return indeterminateReceipt(await read(command.taskId), plan, command.opId, errorMessage(error), `task lifecycle read ${command.taskId}`, event);
      }
    }
  };
}
function recoveryWritePlan(taskId: string): FrozenWritePlan<"StartExecution"> { return freezeWritePlan({ commandType: "StartExecution", targets: [eventTarget(), projectionTarget(taskId), leaseTarget(taskId, "activate"), leaseTarget(taskId, "release")] }); }
async function readAndConverge(projection: ProjectionPort, leases: LeasePort, taskId: string, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): Promise<TaskLifecycleServiceRead> {
  const read = planned(plan, projectionTarget(taskId), () => projection.read(taskId));
  if (read.status !== "ready") return read;
  let lease = leases.current(taskId);
  if (lease !== null) {
    const execution = read.snapshot.executions.find((candidate) => candidate.executionId === lease?.executionId);
    if (lease.phase === "reserving" && execution?.state === "active") lease = await planned(plan, leaseTarget(taskId, "activate"), () => leases.activate(cas(lease!)));
    else if (execution?.state !== "active") {
      await planned(plan, leaseTarget(taskId, "release"), () => leases.release(cas(lease!)));
      lease = null;
    }
  }
  const activeWithoutLease = read.snapshot.executions.some((execution) => execution.state === "active") && lease === null;
  return { ...read, status: activeWithoutLease ? "pending" : "ready", snapshot: { ...read.snapshot, lease } };
}
async function finalizeLease(leases: LeasePort, command: TaskLifecycleCommand, reservation: LeaseV1 | null, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): Promise<void> {
  if (command.type === "StartExecution" && reservation !== null) {
    await planned(plan, leaseTarget(command.taskId, "activate"), () => leases.activate(cas(reservation)));
  } else if (command.type === "SubmitExecution") {
    const lease = leases.current(command.taskId);
    if (lease !== null) await planned(plan, leaseTarget(command.taskId, "release"), () => leases.release(cas(lease)));
  }
}
async function releaseReservation(leases: LeasePort, reservation: LeaseV1 | null, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): Promise<void> {
  if (reservation === null) return;
  try {
    await planned(plan, leaseTarget(reservation.taskId, "release"), () => leases.release(cas(reservation)));
  } catch (error) {
    consumeKnownError(error);
  }
}
function cas(lease: LeaseV1): LeaseCas {
  return { taskId: lease.taskId, executionId: lease.executionId, actor: lease.actor, source: lease.source, version: lease.version };
}
function eventTarget(): WriteTarget { return { kind: "event_stream", stream: "harness/task-events.ndjson", operation: "append" }; }
function projectionTarget(taskId: string): WriteTarget { return { kind: "projection_invalidation", projection: "task-lifecycle/v1", taskId }; }
function leaseTarget(taskId: string, operation: "reserve" | "activate" | "release"): WriteTarget { return { kind: "lease_sqlite", table: "lease_cas", taskId, operation }; }
function planned<A>(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, target: WriteTarget, write: () => A): A { assertWriteTargetDeclared(plan, target); return write(); }
export function assertWriteTargetDeclared(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, target: WriteTarget): void { if (!Object.isFrozen(plan) || !Object.isFrozen(plan.targets) || !plan.targets.some((candidate) => canonicalJson(candidate) === canonicalJson(target))) throw new TaskLifecycleOperationConflict(`undeclared_write_target: ${canonicalJson(target)}`); }
function receiptFromRead(read: TaskLifecycleServiceRead, event: TaskEventV1, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  return read.status === "ready"
    ? { outcome: "applied", opId: event.opId, event, revision: event.workspaceRevision, evidence: `task-event:${event.eventId}`,
      visibility: "center", proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark }, snapshot: read.snapshot, frozenPlan: plan }
    : pendingReceipt(read, plan, event.opId, "projection or lease convergence is pending", event);
}
function pendingReceipt(read: TaskLifecycleServiceRead, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, opId: string, reason: string, event?: TaskEventV1): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  const revision = event?.workspaceRevision ?? read.sourceRevision;
  return { outcome: "pending", opId, ...(event ? { event } : {}), revision, evidence: `task-stream-revision:${revision}`,
    visibility: "center", proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark },
    snapshot: read.snapshot, frozenPlan: plan, nextAction: `retry task lifecycle read: ${reason}` };
}

function indeterminateReceipt(read: TaskLifecycleServiceRead, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, opId: string, reason: string, query: string, event?: TaskEventV1): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  return { outcome: "indeterminate", opId, ...(event ? { event } : {}), revision: event?.workspaceRevision ?? read.sourceRevision,
    visibility: "center", snapshot: read.snapshot, frozenPlan: plan, code: "publication_unknown", origin: "task-event-store", nextAction: `${query}: ${reason}` };
}

function eventMatchesOperation<C extends TaskLifecycleCommand>(event: TaskEventV1, command: C, proof: ProofFor<C>): boolean {
  return canonicalJson(operationIdentityFromEvent(event)) === canonicalJson(operationIdentityFromCommand(command, proof));
}

function operationIdentityFromCommand<C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>): unknown {
  const common = { type: command.type, taskId: command.taskId, eventId: command.eventId, workspaceRevision: command.workspaceRevision, actor: command.actor, occurredAt: command.occurredAt };
  if (command.type === "CreateReplayTask") return { ...common, title: command.title, graph: command.graph, completionGateIds: command.completionGateIds };
  if (command.type === "StartExecution") return { ...common, executionId: command.executionId };
  if (command.type === "SubmitExecution") return { ...common, executionId: command.executionId, submission: command.submission };
  if (command.type === "CompleteTask") return { ...common, executionId: command.executionId };
  return { ...common, executionId: command.executionId, reviewId: command.reviewId, kind: command.kind, verdict: command.verdict, actorRole: command.actorRole, reason: command.reason, evidenceChecked: command.evidenceChecked, commitSha: command.commitSha, iteration: command.iteration, archiveWarningsAcknowledged: command.archiveWarningsAcknowledged, capabilityRef: (proof as { readonly capabilityRef: string }).capabilityRef };
}

function operationIdentityFromEvent(event: TaskEventV1): unknown {
  const type = event.type === "task_created" ? "CreateReplayTask" : event.type === "execution_started" ? "StartExecution" : event.type === "execution_submitted" ? "SubmitExecution" : event.type === "task_completed" ? "CompleteTask" : "RecordReview";
  const common = { type, taskId: event.taskId, eventId: event.eventId, workspaceRevision: event.workspaceRevision, actor: event.actor, occurredAt: event.occurredAt };
  if (event.type === "task_created") return { ...common, title: event.payload.task.title, graph: event.payload.task.graph, completionGateIds: event.payload.task.completionGateIds };
  if (event.type === "execution_started" || event.type === "task_completed") return { ...common, executionId: event.payload.execution.executionId };
  if (event.type === "execution_submitted") return { ...common, executionId: event.payload.execution.executionId, submission: event.payload.execution.submission };
  const review = event.payload.review;
  return { ...common, executionId: review.executionId, reviewId: review.reviewId, kind: review.kind, verdict: review.verdict, actorRole: review.actorRole, reason: review.reason, evidenceChecked: review.evidenceChecked, commitSha: review.commitSha, iteration: review.iteration, archiveWarningsAcknowledged: review.archiveWarningsAcknowledged, capabilityRef: review.capabilityRef };
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalizeContractValue(value)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function consumeKnownError(error: unknown): void { void error; }
