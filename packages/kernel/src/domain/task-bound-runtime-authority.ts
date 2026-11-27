import { stableStringify } from "../integrity/stable-hash.ts";
import type { RuntimeSession } from "./agent-runtime.ts";
import { isSameExecution, isSamePerson } from "./actor-domain-services.ts";
import type { LeaseV1 } from "./execution.ts";
import { decideReadableTaskLease } from "./task-lease-policy.ts";
import type { TaskV2 } from "./task.ts";
import type { ActorIdentity, WriteSource } from "./write-chain.contract.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle-contract-internal-types.ts";

/** dec_CF96A3C910B31D2D7498F32DDD/CH3: a returned worker may continue into the next leased round. */
export function isReturnedRuntimeContinuation(
  snapshot: TaskLifecycleSnapshot,
  sourceExecutionId: unknown,
  executionId: unknown,
): boolean {
  const previous = snapshot.executions.find((row) => row.executionId === sourceExecutionId),
    current = snapshot.executions.find((row) => row.executionId === executionId);
  return (
    previous?.state === "changes_requested" &&
    current?.state === "active" &&
    current.iteration === previous.iteration + 1 &&
    current.iteration === snapshot.task?.iteration &&
    snapshot.lease?.phase === "held" &&
    snapshot.lease.executionId === current.executionId
  );
}

export interface TaskBoundRuntimeBinding {
  readonly runtimeSessionId: string;
  readonly taskId: string;
  readonly executionId: string;
}

export function runtimeSessionIdFromActor(actor: ActorIdentity): string | null {
  const id = actor.executor?.kind === "agent" ? actor.executor.id : "",
    prefix = "runtime-session:";
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
}

/** Task membership is historical; the caller supplies the execution from the current lease. */
export function resolveTaskBoundRuntimeBinding(
  session: RuntimeSession | null,
  taskId: string,
  executionId: string,
): TaskBoundRuntimeBinding | null {
  if (!session?.taskBindings.some((binding) => binding.taskId === taskId)) return null;
  return { runtimeSessionId: session.runtimeSessionId, taskId, executionId };
}

/** A strict task descendant is reached only by following canonical parent bindings upward. */
export function taskIsDescendantOf(
  taskId: string,
  ancestorTaskId: string,
  parentTaskId: (candidateTaskId: string) => string | null,
): boolean {
  const visited = new Set([taskId]);
  let candidate = parentTaskId(taskId);
  while (candidate !== null && !visited.has(candidate)) {
    if (candidate === ancestorTaskId) return true;
    visited.add(candidate);
    candidate = parentTaskId(candidate);
  }
  return false;
}

export function isTaskBoundRuntimeWriter(
  lease: LeaseV1,
  actor: ActorIdentity,
  source: WriteSource,
  binding: TaskBoundRuntimeBinding,
): boolean {
  return (
    lease.phase === "held" &&
    lease.taskId === binding.taskId &&
    lease.executionId === binding.executionId &&
    isSameExecution(lease.actor, actor) &&
    stableStringify(lease.source) === stableStringify(source) &&
    runtimeSessionIdFromActor(actor) === binding.runtimeSessionId
  );
}

export function isSubmittedExecutionCutOpen(snapshot: TaskLifecycleSnapshot, executionId: string): boolean {
  const task = snapshot.task,
    current = snapshot.executions.find((candidate) => candidate.executionId === executionId);
  if (!task || (task.status !== "submitted" && task.status !== "in_review")) return false;
  return task.currentNode === "review" && current?.state === "submitted" && current.submission !== null;
}

/**
 * Historical task cleanup/disposition commands that an authenticated principal may execute on
 * their own unleased or expired-orphaned task without holding an active lease. Explicitly
 * excludes `task-review-consent` and ordinary review-gated `task-complete`.
 */
export function isHistoricalTaskCleanupAction(action: {
  readonly kind: string;
  readonly status?: unknown;
  readonly resolvedBy?: unknown;
}): boolean {
  if (action.kind === "task-release" || action.kind === "task-archive") return true;
  if (action.kind === "task-transition") return action.status === "cancelled";
  if (action.kind === "task-complete")
    return typeof action.resolvedBy === "string" && action.resolvedBy.trim().length > 0;
  return false;
}

/**
 * Pure domain eligibility for an edge principal self-cleaning their own historical task when
 * no live unexpired lease exists (`lease === null` or an expired `orphaned` lease belonging
 * to the same principal). Active `held`/`reserving` leases, foreign tasks, foreign orphaned
 * leases, and `task-review-consent` always return false.
 */
export function canEdgeSelfCleanHistoricalTask(input: {
  readonly action: { readonly kind: string; readonly status?: unknown; readonly resolvedBy?: unknown };
  readonly task: Pick<TaskV2, "createdBy"> | null;
  readonly lease: LeaseV1 | null;
  readonly actor: ActorIdentity;
}): boolean {
  if (!isHistoricalTaskCleanupAction(input.action)) return false;
  if (input.task === null || !isSamePerson(input.task.createdBy, input.actor)) return false;
  const activeLease = decideReadableTaskLease(input.lease);
  if (activeLease === null) return true;
  return activeLease.phase === "orphaned" && isSamePerson(activeLease.actor, input.actor);
}
