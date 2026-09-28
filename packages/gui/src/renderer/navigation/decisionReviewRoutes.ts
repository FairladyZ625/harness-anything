/**
 * Decision 评审的可寻址落点(设计 Q6 导航契约):评审页签、逐条回应、报告与裁决都落
 * decisionDetail,会话按被评审 Decision 归组落会话页。它们都是读导航别名,不构成新实体;
 * 与 `decision/<id>/<claimId>` 的 claim 引用分开命名,互不遮蔽。
 *
 *   decisionreview/<decisionId>/<tab>[/<reviewId>]   tab ∈ review | respond | report | judge
 *   decisionsessions/<decisionId>[/<runtimeSessionId>]
 */
export type DecisionReviewTab = "review" | "respond" | "report" | "judge";
const reviewTabs: readonly DecisionReviewTab[] = ["review", "respond", "report", "judge"];

export function decisionReviewRef(decisionId: string, tab: DecisionReviewTab, reviewId?: string | null): string {
  return `decisionreview/${decisionId}/${tab}${reviewId ? `/${reviewId}` : ""}`;
}

export function decisionSessionsRef(decisionId: string, runtimeSessionId?: string | null): string {
  return `decisionsessions/${decisionId}${runtimeSessionId ? `/${runtimeSessionId}` : ""}`;
}

/** decisionDetail 的 focusedEntityRef → 决策 id + 评审页签;普通 decision/<id> 没有页签。 */
export function decisionDetailLocation(ref: string | null): {
  readonly decisionId: string;
  readonly tab: DecisionReviewTab | null;
  readonly reviewId: string | null;
} | null {
  if (ref === null) return null;
  const [head, decisionId, tab, reviewId] = ref.split("/");
  if (!decisionId) return null;
  if (head === "decision") return { decisionId, tab: null, reviewId: null };
  if (head !== "decisionreview" || !reviewTabs.includes(tab as DecisionReviewTab)) return null;
  return { decisionId, tab: tab as DecisionReviewTab, reviewId: reviewId || null };
}

export function decisionSessionsLocation(
  ref: string | null,
): { readonly decisionId: string; readonly runtimeSessionId: string | null } | null {
  if (!ref?.startsWith("decisionsessions/")) return null;
  const [, decisionId, runtimeSessionId] = ref.split("/");
  return decisionId ? { decisionId, runtimeSessionId: runtimeSessionId || null } : null;
}
