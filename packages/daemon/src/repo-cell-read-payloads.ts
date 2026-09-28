import type { DaemonTaskDispatchesPayload } from "./protocol/daemon-protocol-gui-types.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";

export function agendaQueryFromPayload(
  context: RepoCellApiContext,
  payload: Readonly<Record<string, unknown>>,
): { readonly limit?: number; readonly cursor?: string; readonly work?: string } {
  if (
    Object.keys(payload).some((field) => !["limit", "cursor", "work"].includes(field)) ||
    (payload.limit !== undefined &&
      (!Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 500)) ||
    (payload.cursor !== undefined && (typeof payload.cursor !== "string" || !payload.cursor)) ||
    (payload.work !== undefined && (typeof payload.work !== "string" || !payload.work))
  )
    throw context.cellCodedError(
      "invalid_command",
      "Agenda accepts --limit 1..500, a non-empty cursor, and a work root task id only.",
    );
  if (typeof payload.work === "string" && !context.projection.readTaskExists(payload.work))
    throw context.cellCodedError(
      "task_not_found",
      `No task ${payload.work}; pass a work root task id from ha work list.`,
    );
  return {
    ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }),
    ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
    ...(typeof payload.work === "string" ? { work: payload.work } : {}),
  };
}

export function taskDispatchesPayloadFromCell(
  context: RepoCellApiContext,
  payload: Readonly<Record<string, unknown>>,
): DaemonTaskDispatchesPayload {
  if (!Array.isArray(payload.taskIds)) return { taskId: context.requiredCellText(payload.taskId, "taskId") };
  const taskIds = payload.taskIds.map((taskId) => context.requiredCellText(taskId, "taskIds[]")),
    limit = payload.limit === undefined ? undefined : Number(payload.limit),
    cursor = payload.cursor === undefined ? undefined : context.requiredCellText(payload.cursor, "cursor");
  if (
    taskIds.length === 0 ||
    taskIds.length > 500 ||
    new Set(taskIds).size !== taskIds.length ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
  )
    throw context.cellCodedError(
      "invalid_command",
      "Task dispatch batch requires 1..500 unique task ids and an optional limit of 1..500.",
    );
  return {
    taskIds,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
