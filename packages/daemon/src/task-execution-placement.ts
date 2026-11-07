import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

export type TaskExecutionPlacement =
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "local" }
  | { readonly kind: "unresolved"; readonly reason: string };

/** Resolves physical placement from the execution's newest lease holder and its own dispatch source. */
export function taskExecutionPlacement(
  cell: RepoCellOperationalContext,
  taskId: string,
  executionId: string,
): TaskExecutionPlacement {
  const interval = cell.projection.readLatestLeaseIntervalForExecution(taskId, executionId);
  if (!interval) return { kind: "unresolved", reason: "the implementation lease holder is unavailable" };
  const leasePlacement = placementFromSource(interval.holder.source);
  if (!leasePlacement)
    return { kind: "unresolved", reason: "the implementation lease holder has no portable node source" };
  const executorId = interval.holder.actor.executor?.id,
    runtimeSessionId = executorId?.startsWith("runtime-session:") ? executorId.slice("runtime-session:".length) : null;
  if (!runtimeSessionId) return leasePlacement;
  const dispatch = cell.projection
    .readRuntimeDispatchesByTaskExecution(taskId, executionId)
    .findLast(({ event }) => event.payload.role !== "reviewer" && event.payload.runtimeSessionId === runtimeSessionId);
  if (!dispatch) return { kind: "unresolved", reason: "the implementation dispatch source is unavailable" };
  const dispatchPlacement = placementFromSource(dispatch.event.source);
  if (!dispatchPlacement || !samePlacement(leasePlacement, dispatchPlacement))
    return { kind: "unresolved", reason: "the implementation dispatch source conflicts with its lease holder" };
  return leasePlacement;
}

function placementFromSource(source: unknown): TaskExecutionPlacement | null {
  if (source === "local") return { kind: "local" };
  return typeof source === "object" &&
    source !== null &&
    "kind" in source &&
    source.kind === "node" &&
    "nodeId" in source &&
    typeof source.nodeId === "string" &&
    source.nodeId.length > 0
    ? { kind: "node", nodeId: source.nodeId }
    : null;
}

function samePlacement(left: TaskExecutionPlacement, right: TaskExecutionPlacement): boolean {
  return left.kind === right.kind && (left.kind !== "node" || (right.kind === "node" && left.nodeId === right.nodeId));
}
