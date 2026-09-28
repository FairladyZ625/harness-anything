import type { DecisionShowRow } from "../api-client-decisions.ts";
import type { DecisionReviewState, DecisionRow } from "./types.ts";

/**
 * Decision 评审的展示级派生(dec_A64B14D6 CH6/CH7):输入全部是 daemon 读面原样结果——
 * 评审/回复/处置数组、当前评审切面摘要、accept 就绪判定与评审派工。这里只按切面分组、
 * 按 id 连接、把读面判定映射成展示信号;「能否 accept」「下一步谁做什么」一律取
 * `readiness`,不在前端重算。
 */
export type DecisionReview = DecisionReviewState["reviews"][number];
export type DecisionReviewResponse = DecisionReviewState["responses"][number];
export type DecisionReviewDispatch = NonNullable<DecisionReviewState["dispatches"]>[number];

/** 评审信号:列表徽章与详情横幅共用一份词表。null = 该行不在待裁状态(没有就绪判定)。 */
export type DecisionReviewSignal =
  | "reviewing"
  | "changesRequested"
  | "unansweredFindings"
  | "approved"
  | "policyUnreviewed"
  | "unreviewed";

export function decisionReviewSignal(review: DecisionReviewState | undefined): DecisionReviewSignal | null {
  const readiness = review?.readiness;
  if (!review || !readiness) return null;
  // 评审中:当前切面上有仍在运行的评审派工(派工状态与切面摘要都来自读面)。
  if (review.dispatches?.some((row) => row.status === "running" && row.reviewContentDigest === review.currentDigest))
    return "reviewing";
  if (readiness.blocker?.code === "changes_requested") return "changesRequested";
  if (readiness.blocker?.code === "unanswered_findings") return "unansweredFindings";
  if (readiness.basis === "review") return "approved";
  return review.reviews.length === 0 ? "unreviewed" : "policyUnreviewed";
}

/** 当前切面与历史切面:按评审自身的 reviewContentDigest 与读面给出的当前摘要比较。 */
export function reviewCuts(review: DecisionReviewState): {
  readonly current: readonly DecisionReview[];
  readonly historical: readonly DecisionReview[];
} {
  const newestFirst = [...review.reviews].sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
  return {
    current: newestFirst.filter((row) => row.reviewContentDigest === review.currentDigest),
    historical: newestFirst.filter((row) => row.reviewContentDigest !== review.currentDigest),
  };
}

/** 一条意见的全部回复(新→旧);第一条即最新回复,原 finding 永不改写。 */
export function findingResponses(
  review: DecisionReviewState,
  reviewId: string,
  findingId: string,
): readonly DecisionReviewResponse[] {
  return review.responses
    .filter((row) => row.reviewId === reviewId && row.findingId === findingId)
    .sort((left, right) => right.respondedAt.localeCompare(left.respondedAt));
}

/** 列举了这条评审的业主处置(处置按切面记录,只对它自己的切面有效)。 */
export function reviewOverrides(review: DecisionReviewState, reviewId: string) {
  return review.overrides.filter((row) => row.reviewIds.includes(reviewId));
}

/**
 * 评审 ↔ 派工:读面在派工行上直接给出该派工登记评审的 reportRef,这里只按 reportRef 相等
 * 连接,不从 reviewId 拼 dispatchId。手工登记(无派工)的评审返回 null。
 */
export function dispatchOfReview(
  review: DecisionReviewState,
  row: Pick<DecisionReview, "reportRef">,
): DecisionReviewDispatch | null {
  if (row.reportRef === null) return null;
  return review.dispatches?.find((dispatch) => dispatch.reportRef === row.reportRef) ?? null;
}

/** 评审报告的定位:报告页按 reviewId 取,正文按该评审的 reportRef 经中心文档读取。 */
export function reviewById(decision: Pick<DecisionRow, "review">, reviewId: string | null): DecisionReview | null {
  if (reviewId === null) return null;
  return decision.review?.reviews.find((row) => row.reviewId === reviewId) ?? null;
}

/** 请求修改的评审里的全部意见(新评审在前):回应表单逐条列出,是否仍阻塞只看读面 readiness。 */
export function respondableFindings(review: DecisionReviewState): readonly {
  readonly review: DecisionReview;
  readonly findingId: string;
  readonly text: string;
  readonly anchor: string | null;
}[] {
  return [...review.reviews]
    .filter((row) => row.verdict === "changes_requested")
    .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))
    .flatMap((row) =>
      row.findings.map((finding) => ({
        review: row,
        findingId: finding.findingId,
        text: finding.text,
        anchor: finding.anchor ?? null,
      })),
    );
}

export function shortDigest(digest: string | null): string {
  if (digest === null) return "—";
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return hex.slice(0, 10);
}

/** 会话页 Decision 组的一轮评审派工:派工行来自读面 reviewDispatches,评审结论按 reportRef 连接。 */
export type DecisionReviewRound = {
  readonly decisionId: string;
  readonly decisionTitle: string | null;
  readonly dispatch: DecisionReviewDispatch;
  readonly review: DecisionReview | null;
  readonly currentDigest: string | null;
};

/** 一个 Decision 的全部评审轮次;读面不含派工(decision-show 行)时返回 null,不冒充空。 */
export function decisionReviewRounds(decision: DecisionRow): readonly DecisionReviewRound[] | null {
  const review = decision.review;
  if (!review?.dispatches) return null;
  return review.dispatches.map((dispatch) => ({
    decisionId: decision.decisionId,
    decisionTitle: decision.title,
    dispatch,
    review:
      dispatch.reportRef === null ? null : (review.reviews.find((row) => row.reportRef === dispatch.reportRef) ?? null),
    currentDigest: review.currentDigest,
  }));
}

/**
 * 评审切面与 accept 就绪只在 decision-show(带正文)上算得出;列表 full 行不带正文,这两项恒为
 * null,只贡献评审派工。合并规则:评审/回复/处置/切面/就绪取 show 行,派工取列表行。
 */
export function withShownReview(decision: DecisionRow, shown: DecisionShowRow | undefined): DecisionRow {
  if (!shown || shown.decisionId !== decision.decisionId) return decision;
  return {
    ...decision,
    review: {
      reviews: shown.reviews,
      responses: shown.reviewResponses,
      overrides: shown.reviewOverrides,
      currentDigest: shown.currentReviewContentDigest,
      readiness: shown.acceptReviewReadiness,
      dispatches: decision.review?.dispatches ?? null,
    },
  };
}
