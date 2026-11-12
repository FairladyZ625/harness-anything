import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import {
  ownerVerifiableFindingCategories,
  reviewFindingCategories,
  type ReviewReverifyRoute,
} from "@harness-anything/kernel";

/** Which round of review one mission is: a fresh cut review, or the continuation after a return. */
export type ReviewPromptPhase = OperationalStatus.ReviewPromptPhase;

/**
 * The finding-scope guidance every reviewer mission carries, in one place. The cut prompt and the
 * path-review lane prompt both quote these sentences, so a review round cannot be told two
 * different rules depending on which dispatch path reached it.
 *
 * The re-review rule deliberately keeps a newly found defect blocking when it breaks a current
 * invariant or the production path: the prior report is input the reviewer verifies, never an
 * authority that can downgrade a visible blocker just because an earlier round missed it.
 */
export function reviewFindingScopePrompt(phase: ReviewPromptPhase): string {
  return phase === "first"
    ? "On the first review, list every blocking finding visible in the frozen cut; do not defer a visible blocker to a later round."
    : "On this re-review, verify each previous finding and inspect the new diff relative to the previous report's cut. " +
        "Report every currently blocking finding: a new finding that breaks a current invariant or the production " +
        "path is blocking; any other new finding is a non-blocking follow-up.";
}

/**
 * Report finding categories are retained as advisory report metadata.
 *
 * The words are the parser's exact vocabulary and do not decide completion.
 */
export const reviewFindingCategoryPrompt =
  `Give every finding a \`category\`, one of: ${reviewFindingCategories.join(", ")}. Keep the finding text and evidence ` +
  "anchors in the report; category is advisory metadata and does not decide completion. A `ci-required` finding records " +
  "the merge gate's observed check state and can never be blocking.";

/**
 * The reverify boundary every task reviewer is told (dec_BEFCF7D0484E901F187C2C8EC6 CH1). The category
 * list comes from the kernel judgment that rejects a load-bearing owner-verify finding.
 */
export const reviewFindingReverifyPrompt =
  "Give every blocking finding a `reverify`: owner-verify when the task owner can confirm the fix alone, " +
  "re-review when an independent reviewer must check it. owner-verify is allowed only for categories " +
  `${ownerVerifiableFindingCategories.join(", ")} (evidence and counts, wording and naming, missing report ` +
  "sections, test- or tool-output-only). A finding that changes production behavior, authorization, " +
  "credentials or security, data or migrations, concurrency or consistency, or an external protocol is " +
  "re-review. When unsure, use re-review; an omitted reverify is re-review.";

/**
 * The scoped re-review mission (dec_BEFCF7D0 CH2/CH3): the reviewer verifies only the previous round's
 * findings that still need an independent check, against the diff since the previous review.
 */
export function scopedReReviewPrompt(route: Extract<ReviewReverifyRoute, { readonly kind: "re-review" }>): string {
  const items = route.pending.map(
    (item) =>
      `${item.reviewId}/${item.finding.findingId} (${item.finding.category ?? "correctness"}, ` +
      `${item.reverify}${item.adopted ? "" : ", not adopted"}): ${item.finding.text}`,
  );
  return [
    "This is a scoped re-review; verify each previous finding listed below, one by one, against the new diff " +
      `relative to the previous report's cut (the diff since ${route.sinceCommit ?? "the previous review's cut"}):`,
    ...items.map((item) => `- ${item}`),
    "Report each as fixed or still blocking. Do not raise new non-blocking findings. A new finding that breaks a " +
      "current invariant or the production path is blocking; state why the previous round could not see it.",
  ].join("\n");
}
