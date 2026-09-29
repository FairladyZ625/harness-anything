import type { AgendaSuccess } from "../api-client.ts";
import type { DecisionReviewState, DecisionRow } from "./types.ts";
import { decisionReviewRef, decisionSessionsRef } from "../navigation/decisionReviewRoutes.ts";

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
  | "reviewRequired"
  | "approved"
  | "policyUnreviewed"
  | "unreviewed";

export function decisionReviewSignal(review: DecisionReviewState | undefined): DecisionReviewSignal | null {
  const readiness = review?.readiness;
  if (!review || !readiness) return null;
  // 互斥主组的先后照设计 Q5:打回未处置先于评审中。
  if (readiness.blocker?.code === "changes_requested") return "changesRequested";
  if (readiness.blocker?.code === "unanswered_findings") return "unansweredFindings";
  // 评审中:当前切面上有仍在运行的评审派工(派工状态与切面摘要都来自读面)。
  if (review.dispatches?.some((row) => row.status === "running" && row.reviewContentDigest === review.currentDigest))
    return "reviewing";
  // 待评审:仓库必审策略要求当前切面有有效批准而还没有(读面 blocker 与议程「待评审」同源)。
  if (readiness.blocker?.code === "review_required") return "reviewRequired";
  if (readiness.basis === "review") return "approved";
  return review.reviews.length === 0 ? "unreviewed" : "policyUnreviewed";
}

/** 工作页的下一步分组(原型 S2):待处置、待评审、评审中、待裁决;信号为 null 的行不入组。 */
export type DecisionReviewGroup = "dispose" | "review" | "reviewing" | "judge";

export function decisionReviewGroup(signal: DecisionReviewSignal): DecisionReviewGroup {
  if (signal === "changesRequested" || signal === "unansweredFindings") return "dispose";
  if (signal === "reviewRequired") return "review";
  return signal === "reviewing" ? "reviewing" : "judge";
}

/**
 * 议程页(原型 S2)与总览(S1)共用的一行 Decision:只有议程读面给的 id、标题与组;
 * 评审中的行另带读面给出的在飞评审人与其已登记的意见数。
 */
export type DecisionAgendaRow = {
  readonly decisionId: string;
  readonly title: string;
  readonly group: DecisionReviewGroup;
  readonly reviewers?: AgendaSuccess["decisionReviewInProgress"][number]["reviewers"];
};

/**
 * 议程读面里的 Decision 行,按待处置 / 待评审 / 评审中 / 待裁决排列:组全部来自议程读面,
 * 不逐条读 Decision、不在前端重新分组。待处置没有自己的议程组,只经「等你处理」的 awaits 行
 * 出现(PR #3053),这里取其中来源是 Decision 的行;同一 Decision 的多条 awaits 只列一次。
 */
export function decisionAgendaRows(agenda: AgendaSuccess): readonly DecisionAgendaRow[] {
  const dispose = new Map<string, DecisionAgendaRow>();
  for (const { sourceRef, title } of agenda.awaitingYou) {
    const [kind, decisionId] = sourceRef.split("/");
    if (kind === "decision" && decisionId && !dispose.has(decisionId))
      dispose.set(decisionId, { decisionId, title, group: "dispose" });
  }
  const rowsOf = (rows: AgendaSuccess["awaitingDecision"], group: DecisionReviewGroup) =>
    rows.map(({ decisionId, title }) => ({ decisionId, title, group }));
  return [
    ...dispose.values(),
    ...rowsOf(agenda.awaitingDecisionReview, "review"),
    ...agenda.decisionReviewInProgress.map(({ decisionId, title, reviewers }) => ({
      decisionId,
      title,
      group: "reviewing" as const,
      reviewers,
    })),
    ...rowsOf(agenda.awaitingDecision, "judge"),
  ];
}

/** 总览四格(原型 S1)的计数:议程 Decision 行按组计数。 */
export function decisionAgendaCounts(agenda: AgendaSuccess): Readonly<Record<DecisionReviewGroup, number>> {
  const rows = decisionAgendaRows(agenda);
  const count = (group: DecisionReviewGroup) => rows.filter((row) => row.group === group).length;
  return { dispose: count("dispose"), review: count("review"), reviewing: count("reviewing"), judge: count("judge") };
}

/**
 * 一行议程 Decision 的落点(原型 S2 各组的「查看」):待处置→逐项回应,待评审→评审页签,
 * 评审中→该 Decision 的评审会话,待裁决→裁决页签。
 */
export function decisionAgendaRowRef({ decisionId, group }: DecisionAgendaRow): string {
  if (group === "reviewing") return decisionSessionsRef(decisionId);
  return decisionReviewRef(decisionId, group === "dispose" ? "respond" : group === "judge" ? "judge" : "review");
}

export type DecisionTileTarget =
  | { readonly kind: "entity"; readonly ref: string }
  | { readonly kind: "view"; readonly view: "agenda" | "sessions" };

/**
 * 四格的点击落点(设计 Q6:待处置→S3,评审中→S5):一格恰好一行时直达那一行的落点;
 * 否则评审中进会话页(Decision 评审分组),其余进议程页。计数不对应单条 Decision 时不替用户挑一条。
 */
export function decisionTileTarget(group: DecisionReviewGroup, rows: readonly DecisionAgendaRow[]): DecisionTileTarget {
  const inGroup = rows.filter((row) => row.group === group);
  if (inGroup.length === 1) return { kind: "entity", ref: decisionAgendaRowRef(inGroup[0]!) };
  return { kind: "view", view: group === "reviewing" ? "sessions" : "agenda" };
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
