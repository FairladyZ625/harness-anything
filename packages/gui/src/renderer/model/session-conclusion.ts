/**
 * 会话详情「最终结论」的派生(task_6bc70402 返工①):首屏先给这次会话的**裁决/结论**,
 * 不是 agent 最后一条消息的原文。
 *
 * 一个会话可能同时有几种"说了什么"的字面材料,优先级从"谁有权下结论"排:
 * 1. 任务评审派工(reviewTarget=task):评审 read 面登记的 verdict + reason——评审的职责就是
 *    判定这次交付成不成立,它的一句话理由就是结论本身。
 * 2. 本次执行的提交 claim(execution.submission.completionClaim):worker 自己写的"做成了
 *    什么",是交付摘要的权威文本(`views/today/today-data.ts` 同一个字段)。
 * 3. 失败/停手的裁决理由(settlement.reason):没成时 daemon 给的故障原文才是结论。
 * 4. 以上都没有才退回 `result.text` 原文,但要剔除过程叙述(见 NARRATION)。
 *
 * 过程叙述("I'll start by…"、"Now let me run…")永远不进首屏:它是转写,不是结论。
 */
import type { AgentRuntimeSessionResult } from "@harness-anything/daemon/protocol";
import type { TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";

type Snapshot = TaskSnapshotProjectionRow["snapshot"];
type Review = Snapshot["reviews"][number];
type Execution = Snapshot["executions"][number];
/** daemon 的终局裁决(协议未从 index 再导出该类型,从会话读结果取成员,不另立镜像)。 */
type Settlement = NonNullable<AgentRuntimeSessionResult["settlement"]>;

/** 结论的来源:决定首屏标题旁的出处标注与测试锚点。 */
export type SessionConclusionSource = "review" | "claim" | "settlement" | "result" | "none";

export interface SessionConclusion {
  readonly source: SessionConclusionSource;
  /** 首屏显示的一段结论(可能多行);空串表示这一类材料存在但没有可用正文。 */
  readonly text: string;
  /** 评审结论只在这一类来源下出现:verdict 的本地化键由视图层查表。 */
  readonly verdict: "approved" | "changes_requested" | "dismissed" | null;
}

/**
 * 过程叙述的判据:agent 最后一条消息常以这些开头——它们是"我正在做什么"的进行时独白,
 * 不是"做成了什么"。只在这些开场白**首次出现且结论正文足够长**时剔除该句/该行,不做
 * 内容改写;命不中就是原文照旧(宁可显示原文,也不猜着删)。
 */
const NARRATION =
  /^(?:I'll|I will|Let me|Now (?:let me|I'll|I will)|First,? I'll|Starting by|I'm going to|正在|让我|我先|先让我|现在让?我)/iu;

/** 结论正文里"交付摘要"该有的最小可读量:太短的行(如 "Done.")不足以剔除下一段真结论。 */
const MIN_CONCLUSION_CHARS = 160;

/** 逐行剔除过程叙述:只删整行都属叙述的行,保留其余行与空行结构。 */
export function stripNarration(text: string): string {
  const lines = text.split("\n"),
    kept = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed === "" || !NARRATION.test(trimmed);
    });
  const joined = kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  // 全篇都是叙述时不能返回空串冒充"没有结论":原文仍是唯一证据,照旧给出。
  return joined === "" ? text.trim() : joined;
}

/** 结论正文的首段:用于首屏折叠态的一行摘要(全文仍可展开)。 */
export function conclusionLead(text: string, limit = 240): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** 一次执行的提交 claim(归档执行没有 commitSha/outputs,但同样带 claim)。 */
function claimOf(execution: Execution): string | null {
  const submission = "archivedSubmission" in execution ? execution.archivedSubmission : execution.submission;
  const claim = submission === null || submission === undefined ? null : submission.completionClaim;
  return typeof claim === "string" && claim.trim().length > 0 ? claim.trim() : null;
}

/**
 * 本次会话绑定的执行:优先 executionId 命中的那一条,否则最近一次提交。与
 * `sessionOutputs` 同一取舍——"本次产出"与"最终结论"必须指同一轮交付,不能一个读本轮
 * claim、另一个把历史轮次的产物列出来。
 */
function ownExecution(executions: readonly Execution[] | undefined, executionId: string | null | undefined) {
  const submitted = [...(executions ?? [])].filter((execution) => {
    const archived = "archivedSubmission" in execution;
    return (
      execution.submittedAt !== null &&
      (archived ? execution.archivedSubmission !== null : execution.submission !== null)
    );
  });
  const own =
    executionId === undefined || executionId === null
      ? undefined
      : submitted.find((execution) => execution.executionId === executionId);
  return (
    own ?? [...submitted].sort((left, right) => (right.submittedAt ?? "").localeCompare(left.submittedAt ?? ""))[0]
  );
}

/**
 * 这条评审派工是否在评审**本次**执行:daemon 的 reviewTarget 带 executionId 与切面 digest,
 * 只认 executionId 相等——不对 digest 再算一次(那是写入边界的活)。
 */
export function reviewOfExecution(reviews: readonly Review[] | undefined, executionId: string | null): Review | null {
  if (executionId === null) return null;
  return (
    [...(reviews ?? [])]
      .filter((review) => review.executionId === executionId)
      .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))[0] ?? null
  );
}

/**
 * 首屏结论。`reviewTarget` 来自派工行(daemon 已下发),`reviews`/`executions` 来自任务投影,
 * `settlement`/`result` 来自会话读面——四个都是既有读面,没有新增协议。
 */
export function sessionConclusion(input: {
  /** 派工行的 reviewTarget:证明"这次会话的角色是评审谁"。 */
  readonly reviewTarget: { readonly kind: "task" | "decision" } | null | undefined;
  readonly reviews: readonly Review[] | undefined;
  readonly executions: readonly Execution[] | undefined;
  readonly executionId: string | null | undefined;
  readonly settlement: Pick<Settlement, "outcome" | "reason"> | null | undefined;
  readonly result: string | null;
}): SessionConclusion {
  const own = ownExecution(input.executions, input.executionId),
    executionId = own?.executionId ?? input.executionId ?? null,
    review = input.reviewTarget?.kind === "task" ? reviewOfExecution(input.reviews, executionId) : null;
  // 1) 评审会话的结论就是 verdict + 理由,不是它最后一条消息。
  if (review !== null && review.reason.trim().length > 0)
    return { source: "review", text: review.reason.trim(), verdict: review.verdict };
  // 2) worker 会话:交付摘要以自己的 completionClaim 为准。
  const claim = own === undefined ? null : claimOf(own);
  if (claim !== null) return { source: "claim", text: claim, verdict: null };
  // 3) 没做成时 daemon 的裁决理由才是结论(故障原文,不是过程叙述)。
  const settlementReason = input.settlement?.reason?.trim() ?? "";
  if (settlementReason.length > 0 && input.settlement?.outcome !== "succeeded")
    return { source: "settlement", text: settlementReason, verdict: null };
  // 4) 只剩 result 原文:剔除过程叙述后仍足够长才当结论,否则宁可不冒充结论。
  const raw = input.result?.trim() ?? "";
  if (raw.length > 0) {
    const stripped = stripNarration(raw);
    if (stripped.length >= Math.min(MIN_CONCLUSION_CHARS, raw.length))
      return { source: "result", text: stripped, verdict: null };
  }
  return { source: "none", text: "", verdict: null };
}

/** 结论来源 → 首屏出处标注的 i18n 键(来源不同,读者对这段话的信任依据也不同)。 */
export const sessionConclusionSourceKey: Readonly<Record<Exclude<SessionConclusionSource, "none">, string>> = {
  review: "agentRuntime.sessionConclusionFromReview",
  claim: "agentRuntime.sessionConclusionFromClaim",
  settlement: "agentRuntime.sessionConclusionFromSettlement",
  result: "agentRuntime.sessionConclusionFromResult",
};

/** 评审 verdict → 状态词的 tone(与 StatusTag 同一套语义)。 */
export const conclusionVerdictTone: Readonly<
  Record<NonNullable<SessionConclusion["verdict"]>, "done" | "bad" | "neutral">
> = { approved: "done", changes_requested: "bad", dismissed: "neutral" };
