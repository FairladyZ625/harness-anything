import { createHash } from "node:crypto";
import type { TaskProjection } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { dispatchLifecyclePendingError } from "./runtime-dispatch-admission.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";

/**
 * The compare half of `ha agent run --task <id> --recover-dispatch <dispatch-id>`: the caller names
 * the implementation dispatch it believes is the task's last one, the execution it ran, and
 * optionally the task revision it read. A daemon-internal disposition that already holds the source
 * dispatch (the incident rerun) may omit the revision; the CLI always sends it.
 */
export interface TaskDispatchRecoveryFence {
  readonly sourceDispatchId: string;
  readonly executionId: string;
  readonly expectedVersion: number | null;
}

/** The deterministic dispatch identity the spawner derives from a dispatch key. */
export function runtimeDispatchIdentity(
  repoId: string,
  dispatchKey: string,
): { readonly dispatchId: string; readonly runtimeSessionId: string } {
  const hash = createHash("sha256").update(`${repoId}\0${dispatchKey}`).digest("hex");
  return { dispatchId: `dispatch_${hash.slice(0, 24)}`, runtimeSessionId: `runtime_${hash.slice(24, 48)}` };
}

function parseFence(value: unknown): TaskDispatchRecoveryFence {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>,
    sourceDispatchId = record.dispatchId,
    executionId = record.executionId,
    expectedVersion = record.expectedVersion;
  if (
    typeof sourceDispatchId !== "string" ||
    !sourceDispatchId.trim() ||
    typeof executionId !== "string" ||
    !executionId.trim() ||
    (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)) ||
    Object.keys(record).some((key) => !["dispatchId", "executionId", "expectedVersion"].includes(key))
  )
    throw runtimeSpawnError(
      "invalid_runtime_spawn",
      "recovery requires { dispatchId, executionId } and an optional non-negative integer expectedVersion.",
    );
  return {
    sourceDispatchId,
    executionId,
    expectedVersion: expectedVersion === undefined ? null : Number(expectedVersion),
  };
}

function implementationDispatches(projection: TaskProjection, taskId: string, executionId: string) {
  return projection
    .readRuntimeDispatchesByTaskExecution(taskId, executionId)
    .map(({ event }) => event)
    .filter((event) => event.payload.role !== "reviewer" && event.payload.role !== "read-only")
    .sort((left, right) =>
      (left.payload.startedAt ?? left.occurredAt).localeCompare(right.payload.startedAt ?? right.occurredAt),
    );
}

function recoveryCommand(taskId: string, agentId: string, dispatchId: string, executionId: string, revision: number) {
  return (
    `ha agent run ${agentId} --task ${taskId} --recover-dispatch ${dispatchId} --execution-id ${executionId} ` +
    `--expected-version ${String(revision)} --idempotency-key <key>`
  );
}

function refuse(code: string, message: string, current: Readonly<Record<string, unknown>>): never {
  throw runtimeSpawnError(code, `${message} Current state: ${JSON.stringify(current)}.`, {
    kind: "validation",
    entity: typeof current.taskId === "string" ? `task ${current.taskId}` : "dispatch",
    field: "recovery",
    actual: JSON.stringify(current),
    expectation: "Re-read ha task dispatches <task-id> and ha task show <task-id>, then recover the current state.",
  });
}

type DispatchEvent = NonNullable<ReturnType<TaskProjection["readRuntimeDispatchById"]>>["event"];

function sourceLifecycle(projection: TaskProjection, source: DispatchEvent) {
  const lifecycle = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [source.payload.dispatchId] });
  if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, runtimeSpawnError);
  return lifecycle.rows[0];
}

export type TaskDispatchAdmission =
  | {
      readonly kind: "spawn";
      readonly payload: JsonObject;
      readonly recovery: JsonObject | null;
      readonly taskRead: ReturnType<typeof requireCurrentTaskProjection> | null;
    }
  | { readonly kind: "replay"; readonly event: DispatchEvent; readonly recovery: JsonObject };

/**
 * Admit a task-bound implementation dispatch at the runtime publication cut. It runs inside the
 * same RepoCell write turn as the spawn itself, so no other dispatch or lease write can land between
 * this comparison and the dispatch event (the lease rejoin is the spawn's own handoff in that turn).
 *
 * - Without a recovery fence, a dispatch is admitted only as the first implementation dispatch of
 *   the task's active execution; a later one must name the dispatch it replaces.
 * - With a fence, the named source must still be the execution's last implementation dispatch, have
 *   a settled terminal verdict and no live process, and the task must still be on that execution and
 *   (when given) revision. The effective dispatch key binds task, source and caller key, so a replay
 *   of the same request returns the dispatch it already produced.
 */
export function admitTaskDispatch(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly payload: JsonObject;
}): TaskDispatchAdmission {
  const { recovery: rawFence, ...payload } = input.payload,
    taskId = typeof payload.taskId === "string" && payload.taskId ? payload.taskId : null;
  if (rawFence === undefined) {
    if (
      taskId === null ||
      payload.role === "reviewer" ||
      typeof payload.dispatchId === "string" ||
      payload.dryRun === true
    )
      return { kind: "spawn", payload, recovery: null, taskRead: null };
    const taskRead = requireCurrentTaskProjection(input.projection, taskId, "runtime.run"),
      snapshot = taskRead.snapshot,
      execution = snapshot.executions.find(
        (candidate) => candidate.state === "active" && candidate.iteration === snapshot.task?.iteration,
      ),
      prior = execution ? implementationDispatches(input.projection, taskId, execution.executionId).at(-1) : undefined;
    // A prior dispatch that is still running (or whose end is not yet settled) keeps the
    // execution lease; the spawn's own lease admission reports that conflict. The fence is the
    // only way to replace a worker that has stopped.
    if (!execution || !prior || !sourceLifecycle(input.projection, prior)?.policy.canRecover)
      return { kind: "spawn", payload, recovery: null, taskRead };
    refuse(
      "dispatch_recovery_fence_required",
      `Execution ${execution.executionId} of task ${taskId} already has implementation dispatch ` +
        `${prior.payload.dispatchId}; name it with ` +
        `${recoveryCommand(taskId, String(payload.agentId ?? "<agent-id>"), prior.payload.dispatchId, execution.executionId, snapshot.revision)}.`,
      {
        taskId,
        executionId: execution.executionId,
        revision: snapshot.revision,
        latestDispatchId: prior.payload.dispatchId,
      },
    );
  }
  if (taskId === null || payload.role === "reviewer" || typeof payload.dispatchId === "string")
    throw runtimeSpawnError(
      "invalid_runtime_spawn",
      "A recovery fence applies only to a task-bound implementation dispatch, not a reviewer or resumed dispatch.",
    );
  const fence = parseFence(rawFence),
    callerKey = typeof payload.dispatchKey === "string" && payload.dispatchKey ? payload.dispatchKey : null;
  if (callerKey === null)
    throw runtimeSpawnError("invalid_runtime_spawn", "A recovery dispatch requires the caller's idempotency key.");
  const dispatchKey = `task-recover:${taskId}:${fence.sourceDispatchId}:${callerKey}`,
    identity = runtimeDispatchIdentity(input.repoId, dispatchKey),
    recovery = {
      schema: "task-dispatch-recovery/v1",
      taskId,
      executionId: fence.executionId,
      ...(fence.expectedVersion === null ? {} : { expectedVersion: fence.expectedVersion }),
      sourceDispatchId: fence.sourceDispatchId,
      idempotencyKey: callerKey,
      dispatchId: identity.dispatchId,
      runtimeSessionId: identity.runtimeSessionId,
    };
  const replayed = input.projection.readRuntimeDispatchById(identity.dispatchId)?.event;
  // A delegated run (`--to`) dispatches its target agent; that is the identity the stored dispatch carries.
  const requestedAgentId = typeof payload.targetAgentId === "string" ? payload.targetAgentId : payload.agentId;
  if (replayed) {
    // The key names task, source and caller key; a replay that changes any other part of the
    // request is a different request under the same key, not a retry.
    if (
      replayed.payload.taskId !== taskId ||
      replayed.payload.executionId !== fence.executionId ||
      (typeof requestedAgentId === "string" && replayed.payload.agentId !== requestedAgentId)
    )
      refuse("idempotency_key_conflict", `Idempotency key ${callerKey} already produced a different dispatch.`, {
        taskId,
        dispatchId: identity.dispatchId,
        executionId: replayed.payload.executionId ?? null,
        agentId: replayed.payload.agentId ?? null,
      });
    return { kind: "replay", event: replayed, recovery: { ...recovery, replayed: true } };
  }
  const taskRead = requireCurrentTaskProjection(input.projection, taskId, "runtime.run"),
    snapshot = taskRead.snapshot,
    task = snapshot.task,
    execution = snapshot.executions.find(
      (candidate) => candidate.state === "active" && candidate.iteration === task?.iteration,
    ),
    current = {
      taskId,
      status: task?.status ?? null,
      revision: snapshot.revision,
      executionId: execution?.executionId ?? null,
    };
  if (!task) refuse("entity_not_found", `Task ${taskId} does not exist.`, current);
  if (task.status !== "active")
    refuse("dispatch_recovery_task_changed", `Task ${taskId} is ${task.status}, not active.`, current);
  if (fence.expectedVersion !== null && fence.expectedVersion !== snapshot.revision)
    refuse(
      "dispatch_recovery_stale_revision",
      `Task ${taskId} is at revision ${String(snapshot.revision)}, not ${String(fence.expectedVersion)}.`,
      current,
    );
  if (execution?.executionId !== fence.executionId)
    refuse(
      "dispatch_recovery_execution_changed",
      `Task ${taskId} active execution is ${execution?.executionId ?? "none"}, not ${fence.executionId}.`,
      current,
    );
  const source = input.projection.readRuntimeDispatchById(fence.sourceDispatchId)?.event;
  if (
    !source ||
    source.payload.taskId !== taskId ||
    source.payload.executionId !== fence.executionId ||
    source.payload.role === "reviewer" ||
    source.payload.role === "read-only"
  )
    refuse(
      "dispatch_recovery_source_mismatch",
      `Dispatch ${fence.sourceDispatchId} is not an implementation dispatch of task ${taskId} execution ${fence.executionId}.`,
      {
        ...current,
        sourceTaskId: source?.payload.taskId ?? null,
        sourceExecutionId: source?.payload.executionId ?? null,
      },
    );
  const lifecycle = sourceLifecycle(input.projection, source),
    sourceState = {
      ...current,
      sourceDispatchId: source.payload.dispatchId,
      sourceOutcome: lifecycle?.attempt.outcome ?? null,
      sourcePhase: lifecycle?.attempt.phase ?? null,
      sourceProcess: lifecycle?.attempt.process ?? null,
    };
  if (!lifecycle?.policy.canRecover)
    refuse(
      lifecycle?.policy.capacityDisposition === "busy"
        ? "dispatch_recovery_source_live"
        : "dispatch_recovery_source_unsettled",
      `Dispatch ${source.payload.dispatchId} is not recoverable according to the dispatch lifecycle.`,
      sourceState,
    );
  const latest = implementationDispatches(input.projection, taskId, fence.executionId).at(-1),
    successor = input.projection.readRuntimeDispatchByResumeSource(source.payload.dispatchId)?.event;
  if (latest?.payload.dispatchId !== source.payload.dispatchId || successor)
    refuse(
      "dispatch_recovery_superseded",
      `Dispatch ${source.payload.dispatchId} is no longer the execution's last implementation dispatch.`,
      { ...sourceState, latestDispatchId: (successor ?? latest)?.payload.dispatchId ?? null },
    );
  return { kind: "spawn", payload: { ...payload, dispatchKey }, recovery, taskRead };
}
