// @slice-activation P4 W2 is composed by tests; W3 owns daemon and production publication cutover.
import { Effect } from "effect";
import {
  applyTransition,
  canonicalizeContractValue,
  taskLifecycleWritePlan,
  validateTaskLifecycleCommandEnvelope,
  type FrozenWritePlan,
  type ProofFor,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot,
  type WriteError,
  type WriteOperationReceipt,
  type WriteTarget
} from "../../kernel/src/index.ts";

export async function runTaskLifecycleEffect<A>(effect: Effect.Effect<A, WriteError>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") throw result.left;
  return result.right;
}
export class TaskLifecycleOperationConflict extends Error {
  constructor(message: string) { super(message); this.name = "TaskLifecycleOperationConflict"; }
}
export type TaskLifecycleKillpoint = "after_sqlite_commit" | "before_response_write" | "after_response_write";
export interface TaskLifecycleServiceRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}
interface EventStorePort {
  readonly read: () => { readonly revision: number; readonly events: readonly TaskEventV1[] };
  readonly readEvent: (opId: string) => TaskEventV1 | null;
  readonly append: (event: TaskEventV1) => { readonly status: "applied"; readonly event: TaskEventV1; readonly revision: number };
}
interface ProjectionPort {
  readonly apply: (event: TaskEventV1) => unknown;
  readonly read: (taskId: string) => TaskLifecycleServiceRead;
  readonly readOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null;
}
export interface TaskLifecycleService {
  readonly execute: <C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>) => Promise<WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]>>;
  readonly read: (taskId: string) => Promise<TaskLifecycleServiceRead>;
}

export function makeTaskLifecycleService(options: {
  readonly eventStore: EventStorePort;
  readonly projection: ProjectionPort;
  readonly killpoint?: (point: TaskLifecycleKillpoint) => void;
}): TaskLifecycleService {
  const read = async (taskId: string) => options.projection.read(taskId);
  return {
    read,
    execute: async <C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>) => {
      const envelopeIssues = validateTaskLifecycleCommandEnvelope(command);
      if (envelopeIssues.length > 0) throw new TaskLifecycleOperationConflict(`invalid normalized command envelope: ${envelopeIssues.map((issue) => issue.message).join("; ")}`);
      const plan = taskLifecycleWritePlan(command);
      const existing = options.eventStore.readEvent(command.opId);
      if (existing !== null) {
        if (!eventMatchesOperation(existing, command, proof)) throw new TaskLifecycleOperationConflict(`opId ${command.opId} already has a different payload`);
        if (options.projection.readOperation(command.opId) === null) options.projection.apply(existing);
        return receiptFromRead(await read(command.taskId), existing, plan);
      }
      const current = await read(command.taskId);
      if (current.status !== "ready") return pendingReceipt(current, plan, command.opId, "projection catch-up is pending");
      const event = applyTransition(current.snapshot, command, proof).event;
      plannedPublication(plan, event, () => options.eventStore.append(event));
      try { planned(plan, projectionTarget(command.taskId), () => options.projection.apply(event)); }
      catch (error) { return pendingReceipt(await read(command.taskId), plan, command.opId, errorMessage(error), event); }
      options.killpoint?.("after_sqlite_commit");
      options.killpoint?.("before_response_write");
      const receipt = receiptFromRead(await read(command.taskId), event, plan);
      options.killpoint?.("after_response_write");
      return receipt;
    }
  };
}

function eventTargets(opId: string): readonly [WriteTarget, WriteTarget] {
  return [{ kind: "event_file", path: `harness/events/${opId}.json`, operation: "create" },
    { kind: "event_head", path: "harness/events/head.json", operation: "replace" }];
}
function projectionTarget(taskId: string): WriteTarget { return { kind: "projection_invalidation", projection: "task-lifecycle/v1", taskId }; }
function plannedPublication<A>(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, event: TaskEventV1, write: () => A): A {
  for (const target of eventTargets(event.opId)) assertWriteTargetDeclared(plan, target);
  return write();
}
function planned<A>(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, target: WriteTarget, write: () => A): A {
  assertWriteTargetDeclared(plan, target);
  return write();
}
export function assertWriteTargetDeclared(plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, target: WriteTarget): void {
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.targets) || !plan.targets.some((candidate) => canonicalJson(candidate) === canonicalJson(target))) {
    throw new TaskLifecycleOperationConflict(`undeclared_write_target: ${canonicalJson(target)}`);
  }
}
function receiptFromRead(read: TaskLifecycleServiceRead, event: TaskEventV1, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  return read.status === "ready" && read.watermark >= event.workspaceRevision
    ? { outcome: "applied", opId: event.opId, event, revision: event.workspaceRevision, evidence: `event-file:${event.opId}`,
      visibility: "center", proof: { committedRevision: event.workspaceRevision, appliedCut: event.workspaceRevision }, snapshot: read.snapshot, frozenPlan: plan }
    : pendingReceipt(read, plan, event.opId, "projection catch-up is pending", event);
}
function pendingReceipt(read: TaskLifecycleServiceRead, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, opId: string, reason: string, event?: TaskEventV1): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot, TaskLifecycleCommand["type"]> {
  const revision = event?.workspaceRevision ?? read.sourceRevision;
  return { outcome: "pending", opId, ...(event ? { event } : {}), revision, evidence: `event-file:${opId}`,
    visibility: "center", proof: { committedRevision: revision, appliedCut: read.watermark }, snapshot: read.snapshot,
    frozenPlan: plan, nextAction: `retry task lifecycle read: ${reason}` };
}
function eventMatchesOperation<C extends TaskLifecycleCommand>(event: TaskEventV1, command: C, proof: ProofFor<C>): boolean {
  return canonicalJson(operationIdentityFromEvent(event)) === canonicalJson(operationIdentityFromCommand(command, proof));
}
function operationIdentityFromCommand<C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>): unknown {
  const common = { type: command.type, taskId: command.taskId, eventId: command.eventId, workspaceRevision: command.workspaceRevision, actor: command.actor, source: command.source, occurredAt: command.occurredAt };
  if (command.type === "CreateReplayTask") return { ...common, title: command.title, graph: command.graph, completionGateIds: command.completionGateIds };
  if (command.type === "StartExecution") return { ...common, executionId: command.executionId };
  if (command.type === "SubmitExecution") return { ...common, executionId: command.executionId, submission: command.submission };
  if (command.type === "CompleteTask") return { ...common, executionId: command.executionId };
  return { ...common, executionId: command.executionId, reviewId: command.reviewId, kind: command.kind, verdict: command.verdict, actorRole: command.actorRole,
    reason: command.reason, evidenceChecked: command.evidenceChecked, commitSha: command.commitSha, iteration: command.iteration,
    archiveWarningsAcknowledged: command.archiveWarningsAcknowledged, capabilityRef: (proof as { readonly capabilityRef: string }).capabilityRef };
}
function operationIdentityFromEvent(event: TaskEventV1): unknown {
  const type = event.type === "task_created" ? "CreateReplayTask" : event.type === "execution_started" ? "StartExecution"
    : event.type === "execution_submitted" ? "SubmitExecution" : event.type === "task_completed" ? "CompleteTask" : "RecordReview";
  const common = { type, taskId: event.taskId, eventId: event.eventId, workspaceRevision: event.workspaceRevision, actor: event.actor, source: event.source, occurredAt: event.occurredAt };
  if (event.type === "task_created") return { ...common, title: event.payload.task.title, graph: event.payload.task.graph, completionGateIds: event.payload.task.completionGateIds };
  if (event.type === "execution_started" || event.type === "task_completed") return { ...common, executionId: event.payload.execution.executionId };
  if (event.type === "execution_submitted") return { ...common, executionId: event.payload.execution.executionId, submission: event.payload.execution.submission };
  const review = event.payload.review;
  return { ...common, executionId: review.executionId, reviewId: review.reviewId, kind: review.kind, verdict: review.verdict, actorRole: review.actorRole,
    reason: review.reason, evidenceChecked: review.evidenceChecked, commitSha: review.commitSha, iteration: review.iteration,
    archiveWarningsAcknowledged: review.archiveWarningsAcknowledged, capabilityRef: review.capabilityRef };
}
function canonicalJson(value: unknown): string { return JSON.stringify(canonicalizeContractValue(value)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
