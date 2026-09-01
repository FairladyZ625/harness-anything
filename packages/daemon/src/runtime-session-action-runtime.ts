import {
  attributeEntityActionCriterion,
  getExecutableEntityAction,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { deriveActionResult, type EntityActionCatalogPreparer } from "./entity-action-catalog-executor.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "./repo-cell-types.ts";

export function runtimeSessionActionPreparer(projection: () => TaskProjection): EntityActionCatalogPreparer {
  return (contract, action, binding) => {
    const runtimeSessionId = requiredRuntimeActionText(action.runtimeSessionId, "runtimeSessionId"),
      dispatch = projection()
        .readRuntimeDispatches()
        .find((event) => event.payload.runtimeSessionId === runtimeSessionId),
      dispatchSource = dispatch?.source,
      ingressSource = binding.source,
      localOwner = dispatchSource === "local" && ingressSource === "local";
    if (!localOwner) {
      const scope = binding.assignmentScope;
      if (!scope)
        invalidRuntimeSessionAction(
          "assignment_required",
          "RuntimeSession event ingress requires an authenticated assignment.",
        );
      if (
        !dispatch ||
        typeof dispatchSource !== "object" ||
        dispatchSource.kind !== "assignment" ||
        typeof ingressSource !== "object" ||
        ingressSource.kind !== "assignment" ||
        dispatchSource.nodeId !== ingressSource.nodeId ||
        dispatchSource.assignmentId !== ingressSource.assignmentId
      )
        invalidRuntimeSessionAction(
          "assignment_scope_mismatch",
          "RuntimeSession events must come from the assignment that owns the session dispatch.",
          contract.id,
          "runtime-session/assignment-fence",
        );
      if (
        action.kind === "runtime_session_task_bound" &&
        (scope.scope.kind !== "task" ||
          action.taskId !== scope.scope.taskId ||
          action.executionId !== scope.scope.executionId)
      )
        invalidRuntimeSessionAction(
          "assignment_scope_mismatch",
          "RuntimeSession task and execution binding must match the authenticated assignment.",
          contract.id,
          "runtime-session/task-binding",
        );
    }
    if (!dispatch)
      invalidRuntimeSessionAction(
        "assignment_scope_mismatch",
        "RuntimeSession events require a canonical dispatch owned by their ingress source.",
        contract.id,
        "runtime-session/assignment-fence",
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
