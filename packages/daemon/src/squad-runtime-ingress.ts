import {
  isSamePerson,
  stableStringify,
  type AgentRuntimeEventV1,
  type CanonicalSquadRun,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "./repo-cell-types.ts";
import { requireRuntimeDispatchOwner } from "./runtime-session-action-runtime.ts";

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
    !isSamePerson(dispatch.actor, binding.actor) ||
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
  if (action.opId !== `squad-observed:${String(action.payload.squadRunId)}:${String(action.payload.runRevision)}`)
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
        run.owner.personId !== binding.actor.principal.personId
      )
        throw cell.cellCodedError("execution_scope_mismatch", "Squad continuation must come from its run owner.");
      requireSquadParentExecution(cell.projection, run.taskId, run.executionId);
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

export function requireSquadParentExecution(
  projection: TaskProjectionQueries,
  taskId: string,
  executionId: string,
): void {
  const snapshot = projection.read(taskId).snapshot;
  if (
    !snapshot.task ||
    !snapshot.executions.some(
      (execution) =>
        execution.executionId === executionId &&
        execution.iteration === snapshot.task!.iteration &&
        execution.state === "active",
    )
  )
    throw Object.assign(
      new Error("Squad parent execution is no longer current; the old run cannot resume business actions."),
      { code: "execution_scope_mismatch" },
    );
}
