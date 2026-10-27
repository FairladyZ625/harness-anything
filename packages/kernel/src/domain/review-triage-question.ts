/**
 * The `review-finding-triage` Decision point (dec_6A77D43B8523823ABA1F5E4D3C CH3).
 *
 * This is the low-cost replacement for Anthropic's "another group of agents votes on every
 * finding": one choice question per finding, five classes, probabilities. The center sends it, the
 * center records the answer, and settlement reads that record. A confidence below the finding
 * category's floor, or a disagreement with the reviewer's blocker claim, buys at most one Critic on
 * a different canonical model before a person decides.
 *
 * The declaration is code, not repository configuration, so the option vocabulary and criteria
 * cannot drift from the settlement that consumes them. The confidence floors and the reviewer
 * roster are the repository-configured parts (`review.thresholds.*` in Settings, reviewer agents).
 */
import {
  reviewFindingDispositions,
  reviewFindingThresholds,
  type ReviewFindingDisposition,
  type ReviewFindingThresholds,
} from "./review-settlement.ts";
import type { DecisionQuestionDeclaration } from "./decision-point.ts";

const dispositionText: Readonly<Record<ReviewFindingDisposition, string>> = Object.freeze({
  blocker: "Blocking: this cut must fix the finding before it can pass.",
  non_blocking: "Real but not blocking: worth a follow-up task, not this cut.",
  nit: "Nit: low-impact; record it and close it.",
  pre_existing: "Pre-existing: predates this cut; a follow-up task owns it.",
  false_positive: "False positive: cannot be reproduced or reasoned from the frozen evidence.",
});

export const reviewFindingTriageQuestionVersion = "review-finding-triage/v1";

/** The one question the center sends per finding. */
export const reviewFindingTriageQuestion: DecisionQuestionDeclaration = Object.freeze({
  version: reviewFindingTriageQuestionVersion,
  type: "choice",
  prompt:
    "Based on the frozen target digest, this finding's evidence, and the project's hard review rules, " +
    "classify this one review finding. Return the selected class and a probability for all five. " +
    "If the evidence is incomplete or your confidence is low, do not guess: the center will ask a " +
    "second, different model.",
  options: reviewFindingDispositions.map((id) => ({ id, text: dispositionText[id] })),
  criteria: {
    blocker:
      "The evidence points to a currently reachable correctness, completeness, authorization/security, " +
      "required-CI, migration, or in-effect-decision problem in this cut.",
    non_blocking: "The finding is real and worth following up, but this cut can land without the fix.",
    nit: "Low-impact style or small improvement; record it, do not spend a follow-up task on it.",
    pre_existing: "The problem existed before this cut; follow up without blaming this change.",
    false_positive: "The frozen evidence cannot reproduce the claim, or the reasoning does not hold.",
  },
});

/**
 * The floors the center uses for one cut: the declared defaults, optionally narrowed by a frozen
 * panel manifest. A manifest cannot omit a hard-rule category's floor or lower it below the default.
 */
export function reviewFindingThresholdsFor(
  override: ReviewFindingThresholds | undefined,
): Readonly<Record<(typeof reviewFindingDispositions)[number], number> & ReviewFindingThresholds> {
  const resolved: ReviewFindingThresholds = {
    ...reviewFindingThresholds,
    ...Object.fromEntries(
      Object.entries(override ?? {}).map(([category, floor]) => [
        category,
        Math.max(floor ?? 0, reviewFindingThresholds[category as keyof typeof reviewFindingThresholds] ?? 0),
      ]),
    ),
  };
  return resolved as Readonly<Record<(typeof reviewFindingDispositions)[number], number> & ReviewFindingThresholds>;
}
