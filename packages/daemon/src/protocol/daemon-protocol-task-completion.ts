import type { taskCompletionNext } from "../../../kernel/src/index.ts";
import { isJsonObject } from "./json-rpc-types.ts";

/** One read-only completion next step for a single task, as `ha task complete` would judge it. */
export type DaemonTaskCompletionResult = {
  readonly ok: true;
  readonly taskId: string;
  readonly completionNext: ReturnType<typeof taskCompletionNext>["next"];
  /** The same blocker completionNext narrates, structured so readers judge the stage without parsing action prose. */
  readonly completionBlocker: Pick<
    Exclude<ReturnType<typeof taskCompletionNext>["blocker"], null>,
    "code" | "gate"
  > | null;
};

export function validateDaemonTaskCompletion(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 4 ||
    value.ok !== true ||
    typeof value.taskId !== "string" ||
    !value.taskId
  )
    return ["Invalid task completion read"];
  const blocker = value.completionBlocker;
  if (
    (blocker === null) !== (value.completionNext === null) ||
    (blocker !== null &&
      (!isJsonObject(blocker) ||
        Object.keys(blocker).length !== 2 ||
        typeof blocker.code !== "string" ||
        !blocker.code ||
        typeof blocker.gate !== "string" ||
        !blocker.gate))
  )
    return ["Invalid completionBlocker"];
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
