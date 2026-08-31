import type { TaskProjection } from "../../kernel/src/index.ts";
import type { EntityActionCatalogPreparer } from "./entity-action-catalog-executor.ts";

export function runtimeSessionActionPreparer(projection: () => TaskProjection): EntityActionCatalogPreparer {
  return (_contract, action, binding) => {
    const scope = binding.assignmentScope;
    if (!scope)
      invalidRuntimeSessionAction(
        "assignment_required",
        "RuntimeSession event ingress requires an authenticated assignment.",
      );
    const runtimeSessionId = requiredRuntimeActionText(action.runtimeSessionId, "runtimeSessionId"),
      dispatch = projection()
        .readRuntimeDispatches()
        .find((event) => event.payload.runtimeSessionId === runtimeSessionId),
      dispatchSource = dispatch?.source,
      ingressSource = binding.source;
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
      );
    return { ...action, dispatchId: dispatch.payload.dispatchId };
  };
}

function requiredRuntimeActionText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  invalidRuntimeSessionAction("invalid_runtime_event", `${field} is required.`);
}

function invalidRuntimeSessionAction(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
