import { samePrincipal } from "@harness-anything/kernel";
import {
  canStartExecution,
  stableStringify,
  type AgentRuntimeEventV1,
  type CanonicalSquadRun,
  type TaskProjectionQueries,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, RuntimeIngressAction } from "./repo-cell-types.ts";
import { requireRuntimeDispatchOwner, runtimeDispatchTaskMatches } from "./runtime-session-action-runtime.ts";

type EventAction = Extract<RuntimeIngressAction, { kind: "event" }>;

/** Called inside the existing runtime publication queue, before idempotency replay. */
export function requireSquadRuntimeOwner(
  cell: RepoCellActionContext,
  action: EventAction,
  binding: RepoCellBinding,
): void {
  if (action.type !== "runtime_squad_run_observed") return;
  const ownerDispatchId = action.payload.ownerDispatchId;
  const dispatch =
    typeof ownerDispatchId === "string" ? cell.projection.readRuntimeDispatchById(ownerDispatchId)?.event : null;
  requireRuntimeDispatchOwner(dispatch ?? null, binding, true);
  if (
    !dispatch ||
    !samePrincipal(dispatch.actor.principal, binding.actor.principal) ||
    !runtimeDispatchTaskMatches({
      projection: cell.projection,
      dispatch,
      binding,
      runtimeSessionId: dispatch.payload.runtimeSessionId,
      taskId: String(action.payload.taskId),
      executionId: String(action.payload.executionId),
    }) ||
    !dispatch.payload.squadRun ||
    "ownerDispatchId" in dispatch.payload.squadRun ||
    ["squadRunId", "squadId", "taskId", "executionId", "mission", "leaderAgentId"].some(
      (key) => (dispatch.payload.squadRun as unknown as Record<string, unknown>)[key] !== action.payload[key],
    )
  )
    throw cell.cellCodedError(
      "execution_scope_mismatch",
      "Squad observation must retain its initial dispatch and execution identity.",
    );
  if (action.opId !== `squad-observed-${String(action.payload.squadRunId)}-${String(action.payload.runRevision)}`)
    throw cell.cellCodedError("invalid_runtime_event", "Squad observation identity must use its run revision.");
}

export function requireSquadRuntimeAdmission(
  cell: RepoCellActionContext,
  action: EventAction,
  binding: RepoCellBinding,
): void {
  if (action.type === "runtime_dispatch_requested" && action.payload.squadRun) {
    const context = action.payload.squadRun as unknown as NonNullable<
      Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>["payload"]["squadRun"]
    >;
    if ("ownerDispatchId" in context) {
      const run = cell.projection.readSquadRun(context.squadRunId)?.state as unknown as CanonicalSquadRun | undefined;
      if (
        !run ||
        run.ownerDispatchId !== context.ownerDispatchId ||
        stableStringify(run.owner.source) !== stableStringify(binding.source) ||
        !samePrincipal(run.owner.principal, binding.actor.principal)
      )
        throw cell.cellCodedError("execution_scope_mismatch", "Squad continuation must come from its run owner.");
      requireSquadBusinessAction(cell.projection, { kind: "runtime-run", squadRunId: run.squadRunId }, binding);
      if (action.payload.taskId === run.taskId && action.payload.executionId !== run.executionId)
        throw cell.cellCodedError("execution_scope_mismatch", "Squad leader must retain the parent execution.");
    } else {
      if (cell.projection.readSquadRun(context.squadRunId))
        throw cell.cellCodedError("op_conflict", "Squad run already has an initial dispatch.");
      if (
        context.taskId !== action.payload.taskId ||
        context.executionId !== action.payload.executionId ||
        context.squadId !== action.payload.squadId ||
        context.leaderAgentId !== action.payload.agentId
      )
        throw cell.cellCodedError(
          "execution_scope_mismatch",
          "Initial Squad dispatch must match its task, execution and leader.",
        );
      requireSquadParentExecution(cell.projection, context.taskId, context.executionId);
    }
  }
  if (action.type !== "runtime_squad_run_observed") return;
  const next = action.payload as unknown as Extract<
    AgentRuntimeEventV1,
    { type: "runtime_squad_run_observed" }
  >["payload"];
  const current = cell.projection.readSquadRun(next.squadRunId)?.state as unknown as CanonicalSquadRun | undefined;
  if (!current)
    throw cell.cellCodedError("execution_scope_mismatch", "Squad observation requires an accepted initial dispatch.");
  if (next.runRevision <= current.runRevision)
    throw cell.cellCodedError(
      "op_conflict",
      "Squad observation revision is stale or conflicts with the current observation.",
    );
  const terminal = ["cancelled", "converged", "failed"];
  if (terminal.includes(current.phase) && next.phase !== current.phase)
    throw cell.cellCodedError("op_conflict", "A terminal Squad run cannot change phase.");
  if (!terminal.includes(next.phase)) requireSquadParentExecution(cell.projection, current.taskId, current.executionId);
  for (const reference of [...next.leaderTurns, ...next.workerAttempts]) {
    if (reference.dispatchId === null && reference.runtimeSessionId === null) continue;
    const dispatch = reference.dispatchId ? cell.projection.readRuntimeDispatchById(reference.dispatchId)?.event : null;
    if (
      !dispatch ||
      dispatch.payload.runtimeSessionId !== reference.runtimeSessionId ||
      dispatch.payload.squadRun?.squadRunId !== next.squadRunId
    )
      throw cell.cellCodedError(
        "execution_scope_mismatch",
        "Squad observations can reference only accepted dispatches belonging to this run.",
      );
  }
}

/** The run identifies an existing dispatch owner; it does not grant a new task execution. */
export function requireSquadBusinessAction(
  projection: Pick<TaskProjectionQueries, "read" | "readSquadRun">,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): void {
  if (action.squadRunId === undefined) return;
  const run =
    typeof action.squadRunId === "string"
      ? (projection.readSquadRun(action.squadRunId)?.state as unknown as CanonicalSquadRun | undefined)
      : undefined;
  if (
    !run ||
    stableStringify(run.owner.source) !== stableStringify(binding.source) ||
    !samePrincipal(run.owner.principal, binding.actor.principal) ||
    ["cancelled", "converged", "failed"].includes(run.phase) ||
    (action.kind === "task-create" && action.parentTaskId !== run.taskId) ||
    (action.kind === "task-start" && action.taskId === run.taskId && action.executionId !== run.executionId) ||
    (action.kind === "task-release" &&
      projection.read(String(action.taskId)).snapshot.lease?.executionId !== action.executionId)
  )
    throw Object.assign(new Error("Squad business action must retain its active run owner and parent execution."), {
      code: "execution_scope_mismatch",
    });
  requireSquadParentExecution(projection, run.taskId, run.executionId);
}

export function squadParentExecutionCurrent(snapshot: TaskLifecycleSnapshot, executionId: string): boolean {
  return (
    snapshot.executions.some(
      (execution) =>
        execution.executionId === executionId &&
        execution.iteration === snapshot.task?.iteration &&
        execution.state === "active",
    ) && canStartExecution({ ...snapshot, lease: null }, executionId)
  );
}

export function requireSquadParentExecution(
  projection: Pick<TaskProjectionQueries, "read">,
  taskId: string,
  executionId: string,
): void {
  if (!squadParentExecutionCurrent(projection.read(taskId).snapshot, executionId))
    throw Object.assign(
      new Error("Squad parent execution is no longer current; the old run cannot resume business actions."),
      { code: "execution_scope_mismatch" },
    );
}
