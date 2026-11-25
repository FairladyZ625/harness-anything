import {
  retiredTaskClassRestatements,
  type TaskProjection,
  type TaskProjectionListQuery,
} from "@harness-anything/kernel";
import type { CommandAction, CommandOperationPort } from "./command-ports.ts";

export type ContractMigrationRow = {
  readonly taskId: string;
  readonly status: string;
  readonly [field: string]: unknown;
};

/** Selection candidates for a filter/before archive: the narrow task index
 * scan with the status filter pushed down, so bulk archive no longer pays for
 * the wide guiTasks assembly (graph reads, blocking, placement, evidence) only
 * to discard it. The before bound stays a JS comparison because it compares
 * parsed instants, not raw timestamp strings. */
export function archiveCandidateIds(
  cell: Pick<CommandOperationPort, "cellCodedError"> & { readonly projection: Pick<TaskProjection, "readTaskIndex"> },
  action: CommandAction,
): readonly string[] {
  const state = /^state:(.+)$/u.exec(String(action.filter ?? ""))?.[1],
    before = typeof action.before === "string" ? Date.parse(action.before) : Number.NaN;
  if (action.before && Number.isNaN(before))
    throw cell.cellCodedError("invalid_command", "Use an ISO-compatible --before date, then retry task archive.");
  return cell.projection
    .readTaskIndex(state === undefined ? {} : { status: state as TaskProjectionListQuery["status"] })
    .rows.filter((row) => !action.before || Date.parse(row.updatedAt) < before)
    .map(({ taskId }) => taskId);
}

/**
 * dec_5F7E74F1 retired the milestone and epic task classes. The same contract-migrate event restates a
 * task still carrying one to its mapped class; its presetId stays the provenance of the content-addressed
 * preset snapshot it was born from.
 */
export function withRetiredTaskClass(
  cell: { readonly projection: Pick<TaskProjection, "read"> },
  taskId: string,
  row: ContractMigrationRow,
): ContractMigrationRow {
  const taskClass: string | undefined = cell.projection.read(taskId).snapshot.task?.taskClass,
    restated = taskClass === undefined ? undefined : retiredTaskClassRestatements[taskClass];
  if (restated === undefined || row.status === "manual" || row.taskClassAfter !== undefined) return row;
  return {
    ...row,
    status: row.status === "current" ? "repair" : row.status,
    disposition: row.disposition ?? "retired-task-class-restated",
    taskClassBefore: taskClass,
    taskClassAfter: restated,
  };
}
