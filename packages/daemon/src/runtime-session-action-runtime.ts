import {
  attributeEntityActionCriterion,
  getExecutableEntityAction,
  type TaskProjection,
  type AgentRuntimeEventV1,
  stableStringify,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { deriveActionResult, type EntityActionCatalogPreparer } from "./entity-action-catalog-executor.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "./repo-cell-types.ts";

export function runtimeSessionActionPreparer(projection: () => TaskProjection): EntityActionCatalogPreparer {
  return (contract, action, binding) => {
    const runtimeSessionId = requiredRuntimeActionText(action.runtimeSessionId, "runtimeSessionId"),
      dispatch = projection().readRuntimeDispatch(runtimeSessionId),
      dispatchSource = dispatch?.source,
      ingressSource = binding.source,
      localOwner = dispatchSource === "local" && ingressSource === "local";
    requireRuntimeDispatchOwner(dispatch, binding);
    if (!localOwner) {
      if (
        !dispatch ||
        typeof dispatchSource !== "object" ||
        dispatchSource.kind !== "node" ||
        typeof ingressSource !== "object" ||
        ingressSource.kind !== "node" ||
        dispatch.actor.principal.personId !== binding.actor.principal.personId ||
        dispatchSource.nodeId !== ingressSource.nodeId
      )
        invalidRuntimeSessionAction(
          "execution_scope_mismatch",
          "RuntimeSession events must come from the node and owner that own the session dispatch.",
          contract.id,
          "runtime-session/node-fence",
        );
      const claimedTask =
        action.kind === "runtime_session_task_bound"
          ? { taskId: action.taskId, executionId: action.executionId }
          : action.kind === "runtime_session_started" &&
              typeof action.taskBinding === "object" &&
              action.taskBinding !== null &&
              "taskId" in action.taskBinding &&
              "executionId" in action.taskBinding
            ? { taskId: action.taskBinding.taskId, executionId: action.taskBinding.executionId }
            : null;
      if (
        claimedTask !== null &&
        (claimedTask.taskId !== dispatch.payload.taskId || claimedTask.executionId !== dispatch.payload.executionId)
      )
        invalidRuntimeSessionAction(
          "execution_scope_mismatch",
          "RuntimeSession task and execution binding must match the canonical dispatch.",
          contract.id,
          "runtime-session/task-binding",
        );
    }
    if (!dispatch)
      invalidRuntimeSessionAction(
        "execution_scope_mismatch",
        "RuntimeSession events require a canonical dispatch owned by their ingress source.",
        contract.id,
        "runtime-session/node-fence",
      );
    return { ...action, dispatchId: dispatch.payload.dispatchId };
  };
}

/** Commit one RuntimeSession catalog Action while the caller owns the RepoCell writer queue. */
export async function commitRuntimeSessionAction(
  cell: RepoCellActionContext,
  action: Extract<RuntimeIngressAction, { readonly kind: "event" }>,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const catalogAction = {
      kind: action.type,
      ...action.payload,
      ...(action.resultBody === undefined ? {} : { resultBody: action.resultBody }),
      idempotencyKey: action.opId,
    },
    contract = getExecutableEntityAction(catalogAction.kind);
  if (!contract || contract.target.kind !== "runtime-session")
    throw Object.assign(new Error(`${catalogAction.kind} is not a RuntimeSession catalog Action.`), {
      code: "invalid_store",
    });
  try {
    return await cell.entityActionExecutor.run(catalogAction, binding, action.opId, cell.entityActionRuntimes);
  } catch (error) {
    if (cell.store.readEvent(action.opId))
      try {
        return await cell.entityActionExecutor.run(catalogAction, binding, action.opId, cell.entityActionRuntimes);
      } catch (replayError) {
        return deriveActionResult(
          contract,
          catalogAction,
          cell.failed(action.opId, replayError, contract, catalogAction),
        );
      }
    return deriveActionResult(contract, catalogAction, cell.failed(action.opId, error, contract, catalogAction));
  }
}

function requiredRuntimeActionText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  invalidRuntimeSessionAction("invalid_runtime_event", `${field} is required.`);
}

function invalidRuntimeSessionAction(code: string, message: string, actionId?: string, criterionRef?: string): never {
  const error = Object.assign(new Error(message), { code });
  throw actionId && criterionRef ? attributeEntityActionCriterion(error, actionId, criterionRef) : error;
}

/** Shared occurrence source check; Squad observations also require the local principal. */
export function requireRuntimeDispatchOwner(
  dispatch: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }> | null,
  binding: RepoCellBinding,
  strictLocalPrincipal = false,
): void {
  const local = dispatch?.source === "local" && binding.source === "local";
  if (
    !dispatch ||
    (!local && stableStringify(dispatch.source) !== stableStringify(binding.source)) ||
    ((!local || strictLocalPrincipal) && dispatch.actor.principal.personId !== binding.actor.principal.personId)
  )
    invalidRuntimeSessionAction(
      "execution_scope_mismatch",
      "Runtime publication must come from the canonical dispatch owner and source.",
    );
}

/** Historical task attribution shared by dispatch archives and run observations. */
export function runtimeDispatchTaskMatches(input: {
  readonly projection: Pick<TaskProjection, "readRuntimeSession" | "readLeaseIntervals">;
  readonly dispatch: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }> | null | undefined;
  readonly binding: RepoCellBinding;
  readonly runtimeSessionId: string;
  readonly taskId: string;
  readonly executionId: string | null;
}): boolean {
  const { projection, dispatch, binding, runtimeSessionId, taskId, executionId } = input;
  return (
    projection
      .readRuntimeSession(runtimeSessionId)
      ?.taskBindings.some((scope) => scope.taskId === taskId && scope.executionId === executionId) === true ||
    projection
      .readLeaseIntervals(taskId)
      .some(
        (interval) =>
          interval.executionId === executionId &&
          interval.holder.actor.executor?.id === `runtime-session:${runtimeSessionId}` &&
          interval.holder.actor.principal.personId === binding.actor.principal.personId,
      ) ||
    (dispatch?.payload.taskId === taskId &&
      dispatch.payload.executionId === executionId &&
      stableStringify(dispatch.source) === stableStringify(binding.source))
  );
}
