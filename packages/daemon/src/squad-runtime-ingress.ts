import {
  isSamePerson,
  canStartExecution,
  stableStringify,
  type AgentRuntimeEventV1,
  type CanonicalSquadRun,
  type ScheduleV1,
  type SquadRunSubjectV1,
  type TaskProjectionQueries,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, RuntimeIngressAction } from "./repo-cell-types.ts";
import { requireRuntimeDispatchOwner, runtimeDispatchTaskMatches } from "./runtime-session-action-runtime.ts";

type EventAction = Extract<RuntimeIngressAction, { kind: "event" }>;
type SquadRunIdentityFields = {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly subject: SquadRunSubjectV1;
  readonly mission: string;
  readonly leaderAgentId: string;
};

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
  const context =
    dispatch?.payload.squadRun && !("ownerDispatchId" in dispatch.payload.squadRun)
      ? (dispatch.payload.squadRun as unknown as SquadRunIdentityFields)
      : null;
  const observed = action.payload as unknown as SquadRunIdentityFields;
  if (
    !dispatch ||
    !isSamePerson(dispatch.actor, binding.actor) ||
    !context ||
    (["squadRunId", "squadId", "mission", "leaderAgentId"] as const).some((key) => context[key] !== observed[key]) ||
    stableStringify(context.subject) !== stableStringify(observed.subject) ||
    !squadDispatchSubjectMatches(cell, dispatch, context.subject, binding)
  )
    throw cell.cellCodedError(
      "execution_scope_mismatch",
      "Squad observation must retain its initial dispatch and execution identity.",
    );
  if (action.opId !== `squad-observed-${String(action.payload.squadRunId)}-${String(action.payload.runRevision)}`)
    throw cell.cellCodedError("invalid_runtime_event", "Squad observation identity must use its run revision.");
}

/** The initial dispatch carries its run's subject: a task subject as its task execution, a
 * schedule-occurrence subject with no task identity at all. */
function squadDispatchSubjectMatches(
  cell: Pick<RepoCellActionContext, "projection">,
  dispatch: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>,
  subject: SquadRunSubjectV1,
  binding: RepoCellBinding,
): boolean {
  if (subject.kind === "schedule-occurrence") return dispatch.payload.taskId === undefined;
  return runtimeDispatchTaskMatches({
    projection: cell.projection,
    dispatch,
    binding,
    runtimeSessionId: dispatch.payload.runtimeSessionId,
    taskId: subject.taskId,
    executionId: subject.executionId,
  });
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
      requireSquadBusinessAction(cell.projection, { kind: "runtime-run", squadRunId: run.squadRunId }, binding);
      if (
        run.subject.kind === "task" &&
        action.payload.taskId === run.subject.taskId &&
        action.payload.executionId !== run.subject.executionId
      )
        throw cell.cellCodedError("execution_scope_mismatch", "Squad leader must retain the parent execution.");
    } else {
      if (cell.projection.readSquadRun(context.squadRunId))
        throw cell.cellCodedError("op_conflict", "Squad run already has an initial dispatch.");
      if (context.squadId !== action.payload.squadId || context.leaderAgentId !== action.payload.agentId)
        throw cell.cellCodedError(
          "execution_scope_mismatch",
          "Initial Squad dispatch must match its squad and leader.",
        );
      if (context.subject.kind === "task") {
        if (
          context.subject.taskId !== action.payload.taskId ||
          context.subject.executionId !== action.payload.executionId
        )
          throw cell.cellCodedError(
            "execution_scope_mismatch",
            "Initial Squad dispatch must match its task and execution.",
          );
        requireSquadParentExecution(cell.projection, context.subject.taskId, context.subject.executionId);
      } else {
        if (!squadScheduleClaimCurrent(cell.projection, context.subject))
          throw cell.cellCodedError(
            "execution_scope_mismatch",
            "Initial Squad dispatch must ride its claimed schedule occurrence.",
          );
      }
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
  if (!terminal.includes(next.phase)) requireSquadRunSubjectCurrent(cell.projection, current.subject);
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
  projection: Pick<TaskProjectionQueries, "read" | "readSquadRun" | "getEntity">,
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
    run.owner.personId !== binding.actor.principal.personId ||
    ["cancelled", "converged", "failed"].includes(run.phase) ||
    (action.kind === "task-create" && !squadChildParentMatches(run.subject, action.parentTaskId)) ||
    (action.kind === "task-start" &&
      run.subject.kind === "task" &&
      action.taskId === run.subject.taskId &&
      action.executionId !== run.subject.executionId) ||
    (action.kind === "task-release" &&
      projection.read(String(action.taskId)).snapshot.lease?.executionId !== action.executionId)
  )
    throw Object.assign(new Error("Squad business action must retain its active run owner and parent execution."), {
      code: "execution_scope_mismatch",
    });
  requireSquadRunSubjectCurrent(projection, run.subject);
}

/** Assignment children hang off the run's subject: a task run's children parent to its task; a
 * schedule-occurrence run's children are parentless, keyed to the run by squadRunId alone. */
function squadChildParentMatches(subject: SquadRunSubjectV1, parentTaskId: unknown): boolean {
  return subject.kind === "task" ? parentTaskId === subject.taskId : parentTaskId === undefined;
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

/** The occurrence claim is a schedule-occurrence run's only concurrency subject: the run stays
 * admissible exactly while its claimFence is the schedule's active run. */
export function squadScheduleClaimCurrent(
  projection: Pick<TaskProjectionQueries, "getEntity">,
  subject: Extract<SquadRunSubjectV1, { readonly kind: "schedule-occurrence" }>,
): boolean {
  const schedule = projection.getEntity("schedule", subject.scheduleId)?.value as ScheduleV1 | undefined;
  return schedule?.status.activeRun?.claimFence === subject.claimFence;
}

export function squadRunSubjectCurrent(
  projection: Pick<TaskProjectionQueries, "read" | "getEntity">,
  subject: SquadRunSubjectV1,
): boolean {
  return subject.kind === "task"
    ? squadParentExecutionCurrent(projection.read(subject.taskId).snapshot, subject.executionId)
    : squadScheduleClaimCurrent(projection, subject);
}

export function requireSquadRunSubjectCurrent(
  projection: Pick<TaskProjectionQueries, "read" | "getEntity">,
  subject: SquadRunSubjectV1,
): void {
  if (squadRunSubjectCurrent(projection, subject)) return;
  throw Object.assign(
    new Error(
      subject.kind === "task"
        ? "Squad parent execution is no longer current; the old run cannot resume business actions."
        : "Squad schedule occurrence claim is no longer current; the old run cannot resume business actions.",
    ),
    { code: "execution_scope_mismatch" },
  );
}
