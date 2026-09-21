import type { taskCompletionNext } from "@harness-anything/kernel";
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
  /**
   * Upstream Facts still needing an explicit still-holds/superseded disposition at completion,
   * exposed before the write so fact_retirement_undeclared is never a surprise. Null when the
   * gate is off, nothing is undischarged, or the relation neighborhood is not projected yet.
   */
  readonly factRetirement: {
    readonly undischarged: readonly {
      readonly factRef: string;
      readonly viaClaim: string;
      readonly viaDecision: string;
    }[];
  } | null;
};

export function validateDaemonTaskCompletion(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    typeof value.taskId !== "string" ||
    !value.taskId ||
    !("completionNext" in value) ||
    !("completionBlocker" in value)
  )
    return ["Invalid task completion read"];
  // factRetirement is an additive field: absent on older producers, validated when present.
  if (
    "factRetirement" in value &&
    value.factRetirement !== null &&
    (!isJsonObject(value.factRetirement) ||
      !Array.isArray(value.factRetirement.undischarged) ||
      value.factRetirement.undischarged.some(
        (entry) =>
          !isJsonObject(entry) ||
          typeof entry.factRef !== "string" ||
          !entry.factRef ||
          typeof entry.viaClaim !== "string" ||
          typeof entry.viaDecision !== "string",
      ))
  )
    return ["Invalid factRetirement"];
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
