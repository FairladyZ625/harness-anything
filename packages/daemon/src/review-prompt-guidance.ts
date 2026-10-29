/** Which round of review one mission is: a fresh cut review, or the continuation after a return. */
export type ReviewPromptPhase = "first" | "re-review";

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
  "Give every finding a `category`, one of: correctness, completeness, security-auth, data-loss, " +
  "ci-required, migration, decision-break, style, diagnostic, cleanup. Keep the finding text and evidence " +
  "anchors in the report; category is advisory metadata and does not decide completion.";
