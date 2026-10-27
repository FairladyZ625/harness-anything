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
 * The per-finding category every reported finding carries (dec_6A77D43B8523823ABA1F5E4D3C CH2/CH3).
 *
 * `category` is what lets the center settle findings one at a time instead of judging a whole cut
 * from a single verdict: style, diagnostic noise and cleanup are discarded before settlement, and
 * the rest are measured against a per-category confidence floor. It is only safe to ask for this
 * now that a producer writes the triage records — without one, a categorized finding could only
 * escalate. The words are the parser's exact vocabulary, not a paraphrase of it.
 */
export const reviewFindingCategoryPrompt =
  "Give every finding a `category`, one of: correctness, completeness, security-auth, data-loss, " +
  "ci-required, migration, decision-break, style, diagnostic, cleanup. Use style, diagnostic or cleanup " +
  "only when the finding changes no behaviour; those three are discarded before settlement. A finding " +
  "that breaks a project hard rule (data loss, security or authorization, a required CI conclusion, a " +
  "breaking in-effect decision, an undeleted old path, or a persisted-format change without a migration) " +
  "must also carry its evidence anchor and evidenceDigest: a hard-rule finding without complete evidence " +
  "escalates to a person instead of settling.";
