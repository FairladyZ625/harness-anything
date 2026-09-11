import type { taskCompletionNext } from "../../../kernel/src/index.ts";
import { isJsonObject } from "./json-rpc-types.ts";

export const TASK_COMPLETION_READ_SCHEMA = "daemon.task-completion/v1";
export interface TaskCompletionRead {
  readonly ok: true;
  readonly taskId: string;
  readonly completionNext: ReturnType<typeof taskCompletionNext>["next"];
}

export function validateTaskCompletionRead(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 3 ||
    value.ok !== true ||
    typeof value.taskId !== "string" ||
    !value.taskId
  )
    return ["Invalid task completion read"];
  const next = value.completionNext;
  if (next === null) return [];
  if (
    !isJsonObject(next) ||
    Object.keys(next).length !== 4 ||
    typeof next.reason !== "string" ||
    !next.reason ||
    typeof next.action !== "string" ||
    !next.action ||
    typeof next.authority !== "string" ||
    !next.authority ||
    !isJsonObject(next.readCut)
  )
    return ["Invalid completionNext"];
  const cut = next.readCut;
  return Object.keys(cut).length === 3 &&
    Number.isSafeInteger(cut.revision) &&
    Number(cut.revision) >= 0 &&
    (cut.iteration === null || (Number.isSafeInteger(cut.iteration) && Number(cut.iteration) >= 0)) &&
    (cut.executionId === null || (typeof cut.executionId === "string" && cut.executionId.length > 0))
    ? []
    : ["Invalid completionNext.readCut"];
}

export function serializeTaskCompletionRead(value: TaskCompletionRead): string {
  const errors = validateTaskCompletionRead(value);
  if (errors.length) throw new Error(errors.join("; "));
  return JSON.stringify(value);
}
