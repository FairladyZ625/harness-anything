/**
 * Per-finding review settlement — the one pass unit shared by Task and Decision review
 * (dec_6A77D43B8523823ABA1F5E4D3C CH2/CH3/CH5).
 *
 * A reviewer's overall `approved`/`changes_requested` is only an input. What decides a cut is each
 * finding's disposition: a blocker returns it, every other finding is closed with a recorded reason
 * or handed to a follow-up owner, and anything that could not be classified safely escalates to a
 * person instead of being guessed through.
 *
 * Style, diagnostic, and cleanup notes never enter settlement: the entry filter drops them, so a
 * reviewer cannot spend the cut's pass budget on formatting.
 *
 * The Decision API (`review-finding-triage`) produces the triage record this judgment consumes. A
 * missing, low-confidence, or conflicting triage is not a reason to pass: it escalates. A finding
 * that hits a project hard rule with complete evidence is a blocker no matter which label the
 * reviewer used or how the model probabilities fell.
 */
import type { ContractValidationIssue } from "./task.ts";
import type { ReviewFindingRulingV1 } from "./review.ts";
import { digest } from "./digest.ts";
import { isNonEmptyString } from "./write-chain.contract.ts";

/** Finding kinds that never reach settlement; the entry filter discards them. */
export const discardedFindingCategories = ["style", "diagnostic", "cleanup"] as const;

/** Finding kinds a reviewer may raise. The first seven enter settlement. */
export const settledFindingCategories = [
  "correctness",
  "completeness",
  "security-auth",
  "data-loss",
  "ci-required",
  "decision-break",
  "migration",
] as const;

export const reviewFindingCategories = [...settledFindingCategories, ...discardedFindingCategories] as const;
export type ReviewFindingCategory = (typeof reviewFindingCategories)[number];
export type SettledFindingCategory = (typeof settledFindingCategories)[number];

/** Anthropic-aligned label kept for triage context; it never decides settlement by itself. */
export const reviewFindingLabels = ["Important", "Nit", "Pre-existing"] as const;
export type ReviewFindingLabel = (typeof reviewFindingLabels)[number];

/** The five classifications the triage Decision point may return. */
export const reviewFindingDispositions = ["blocker", "non_blocking", "nit", "pre_existing", "false_positive"] as const;
export type ReviewFindingDisposition = (typeof reviewFindingDispositions)[number];

/**
 * Initial per-category confidence floors (CH3). They are declared here as the default and are
 * meant to be overridden by repository settings and a frozen panel manifest; a category absent from
 * this table has no automatic classification lane.
 */
export const reviewFindingThresholds: Readonly<Record<SettledFindingCategory, number>> = Object.freeze({
  correctness: 0.8,
  completeness: 0.8,
  "ci-required": 0.85,
  migration: 0.85,
  "decision-break": 0.85,
  "security-auth": 0.9,
  "data-loss": 0.9,
});

/**
 * Categories that cannot be downgraded when their evidence is complete: the project hard rules
 * CH4 carries over (data loss, security/auth, breaking an in-effect decision, required CI red,
 * missing migration for a persisted-format change).
 */
export const hardRuleFindingCategories: readonly SettledFindingCategory[] = Object.freeze([
  "security-auth",
  "data-loss",
  "ci-required",
  "decision-break",
  "migration",
]);

/** Per-category confidence floors a cut may freeze; a missing category uses the declared default. */
export type ReviewFindingThresholds = Readonly<Partial<Record<SettledFindingCategory, number>>>;

export interface ReviewFindingEvidence {
  /** A file:line, event/schema, CI run, or command anchor a reader can check. */
  readonly anchor: string;
  /** Hash of the minimal evidence the reviewer inspected for this finding. */
  readonly evidenceDigest: `sha256:${string}`;
}

/** One finding as the settlement consumes it; adapters map Task and Decision records onto this. */
export interface SettleableReviewFinding {
  readonly reviewId: string;
  readonly findingId: string;
  readonly category: ReviewFindingCategory;
  readonly label: ReviewFindingLabel;
  readonly text: string;
  /** The reviewer's own severity claim; input only, never the verdict. */
  readonly reviewerBlocking: boolean;
  readonly evidence?: ReviewFindingEvidence;
  /** Same opinion from an earlier cut, so a repeat is triaged rather than counted as new. */
  readonly priorFindingRefs?: readonly string[];
}

/** One Decision API answer for one finding. */
export interface ReviewFindingTriageV1 {
  readonly schema: "review-finding-triage/v1";
  readonly reviewId: string;
  readonly findingId: string;
  readonly targetDigest: `sha256:${string}`;
  readonly selected: ReviewFindingDisposition;
  readonly probabilities: Readonly<Record<ReviewFindingDisposition, number>>;
  readonly model: string;
  readonly bindingDigest: `sha256:${string}`;
  readonly decidedAt: string;
  /** The independent Critic's answer when the first pass did not settle the finding. */
  readonly critic?: {
    readonly selected: ReviewFindingDisposition;
    readonly probabilities: Readonly<Record<ReviewFindingDisposition, number>>;
    readonly model: string;
    readonly bindingDigest: `sha256:${string}`;
    readonly decidedAt: string;
  };
}

export type ReviewFindingOutcome =
  /** The finding blocks this cut and the worker owes a fix. */
  | "blocked"
  /** True but not this cut's problem; the owner receives a follow-up task. */
  | "follow_up_owned"
  /** Low-impact or wrong; recorded and closed with the triage reason. */
  | "closed"
  /** No safe classification was possible; a person must decide. */
  | "escalated";

export interface SettledReviewFinding {
  readonly reviewId: string;
  readonly findingId: string;
  readonly category: SettledFindingCategory;
  readonly outcome: ReviewFindingOutcome;
  readonly disposition: ReviewFindingDisposition | null;
  /** Whether a hard rule forced the blocker outcome regardless of labels or probabilities. */
  readonly hardRule: boolean;
  readonly reason: string;
}

export interface ReviewFindingSettlement {
  readonly outcome: "passed" | "changes_requested" | "escalated";
  /** Findings the entry filter dropped before settlement; never counted. */
  readonly discarded: readonly { readonly reviewId: string; readonly findingId: string; readonly category: string }[];
  readonly findings: readonly SettledReviewFinding[];
  readonly blockers: readonly SettledReviewFinding[];
  readonly escalated: readonly SettledReviewFinding[];
  readonly reason: string;
}

export interface ReviewFindingSettlementInput {
  readonly findings: readonly SettleableReviewFinding[];
  readonly triages: readonly ReviewFindingTriageV1[];
  readonly rulings?: readonly ReviewFindingRulingV1[];
  /**
   * The cut these findings belong to. A triage record answers a cut only when it was minted for this
   * digest: `(reviewId, findingId)` is not an identity, because a rebind, a hand-copied report packet
   * or an edge replay can reuse both ids on a different cut. Without this the producer would re-ask
   * the question on an amend while consumption happily reused the stale answer.
   */
  readonly targetDigest: `sha256:${string}`;
  /** Per-cut confidence floors; a category omitted here falls back to `reviewFindingThresholds`. */
  readonly thresholds?: ReviewFindingThresholds | undefined;
}

/**
 * The one settlement both aggregates read. A cut passes only when every entered finding is closed,
 * follow-up owned, or (for a hard-rule blocker that the worker fixed) resolved by a later review;
 * this function sees one cut, so an open blocker returns it.
 */
export function settleReviewFindings(input: ReviewFindingSettlementInput): ReviewFindingSettlement {
  const discarded = input.findings
      .filter((finding) => isDiscardedCategory(finding.category))
      .map(({ reviewId, findingId, category }) => ({ reviewId, findingId, category })),
    entered = input.findings.filter((finding) => !isDiscardedCategory(finding.category));
  const settled = entered.map((finding) =>
    settleOneFinding(finding, input.triages, input.thresholds, input.targetDigest, input.rulings ?? []),
  );
  const blockers = settled.filter(({ outcome }) => outcome === "blocked"),
    escalated = settled.filter(({ outcome }) => outcome === "escalated");
  if (escalated.length > 0)
    return {
      outcome: "escalated",
      discarded,
      findings: settled,
      blockers,
      escalated,
      reason:
        `${String(escalated.length)} finding(s) could not be classified safely: ` +
        `${escalated.map(({ reviewId, findingId }) => `${reviewId}/${findingId}`).join(", ")}.`,
    };
  if (blockers.length > 0)
    return {
      outcome: "changes_requested",
      discarded,
      findings: settled,
      blockers,
      escalated,
      reason: `${String(blockers.length)} blocking finding(s) require a fix on this cut.`,
    };
  return {
    outcome: "passed",
    discarded,
    findings: settled,
    blockers,
    escalated,
    reason:
      entered.length === 0
        ? "No finding entered settlement."
        : `All ${String(entered.length)} finding(s) are disposed.`,
  };
}

/** Keep the entry filter total: an unknown category is settled, never silently dropped. */
export function isDiscardedCategory(category: string): boolean {
  return (discardedFindingCategories as readonly string[]).includes(category);
}

export function isSettledFindingCategory(category: string): category is SettledFindingCategory {
  return (settledFindingCategories as readonly string[]).includes(category);
}

function settleOneFinding(
  finding: SettleableReviewFinding,
  triages: readonly ReviewFindingTriageV1[],
  thresholds: ReviewFindingThresholds | undefined,
  targetDigest: `sha256:${string}`,
  rulings: readonly ReviewFindingRulingV1[],
): SettledReviewFinding {
  const category: SettledFindingCategory = isSettledFindingCategory(finding.category)
      ? finding.category
      : "correctness",
    hardRule = hardRuleFindingCategories.includes(category),
    hardRuleEvidenceComplete = finding.evidence !== undefined,
    // A record answers this cut only when it was minted for it. Ids alone are reusable across cuts
    // (rebind, hand-copied packet, edge replay), so the digest is part of the key, not a shape check.
    triage = triages.find(
      (candidate) =>
        candidate.reviewId === finding.reviewId &&
        candidate.findingId === finding.findingId &&
        candidate.targetDigest === targetDigest,
    ),
    ruling = rulings.find(
      (candidate) =>
        candidate.reviewId === finding.reviewId &&
        candidate.findingId === finding.findingId &&
        candidate.targetDigest === targetDigest,
    ),
    threshold = thresholds?.[category] ?? reviewFindingThresholds[category];
  if (hardRule && hardRuleEvidenceComplete)
    return settled(
      finding,
      category,
      "blocked",
      "blocker",
      true,
      `Project hard rule ${category} with complete evidence.`,
    );
  const ownerRuling = (reason: string): SettledReviewFinding => {
    if (ruling === undefined) return settled(finding, category, "escalated", null, hardRule, reason);
    const result = dispositionOutcome(finding, category, ruling.disposition, hardRule);
    return { ...result, reason: `Owner ruling: ${ruling.rationale}` };
  };
  if (triage === undefined)
    return ownerRuling(
      hardRule
        ? `Project hard rule ${category} needs complete evidence; this finding has none.`
        : "No triage record exists for this finding.",
    );
  const first = confidentDisposition(triage, threshold);
  // Two conflicts require an independent second opinion before the finding can be downgraded: a
  // project hard rule without complete evidence, and a reviewer's own blocker claim that the
  // triage would wave through. Agreeing with the Critic settles it; a disagreement or a low
  // Critic confidence escalates to a person (CH4).
  const needsCritic = first !== null && first !== "blocker" && (hardRule || finding.reviewerBlocking);
  if (triage.critic === undefined) {
    if (first === null)
      return ownerRuling(`Triage confidence stayed below the ${category} floor (${String(threshold)}).`);
    if (needsCritic)
      return ownerRuling(
        hardRule
          ? `Project hard rule ${category} was classified ${first}; a Critic must confirm before it can be downgraded.`
          : `The reviewer claimed a blocker but triage selected ${first}; a Critic must confirm that conflict.`,
      );
    return dispositionOutcome(finding, category, first, hardRule);
  }
  const critic = confidentDisposition(triage.critic, threshold);
  if (critic === null)
    return ownerRuling(`Critic confidence stayed below the ${category} floor (${String(threshold)}).`);
  if (first !== null && first !== critic)
    return ownerRuling(
      `Triage selected ${first} but the Critic selected ${critic}; only a person can settle that conflict.`,
    );
  // Two independent passes that agree settle the finding, including when the reviewer's own label
  // disagreed: the Critic exists precisely to check that conflict (CH4). A hard-rule finding with
  // complete evidence never reaches here.
  return dispositionOutcome(finding, category, critic, hardRule);
}

function confidentDisposition(
  record: Pick<ReviewFindingTriageV1, "selected" | "probabilities">,
  threshold: number,
): ReviewFindingDisposition | null {
  const probabilities = reviewFindingDispositions.map((disposition) => record.probabilities[disposition] ?? 0),
    maximum = Math.max(...probabilities);
  if (!Number.isFinite(maximum) || maximum < threshold) return null;
  // The declared selection must be the most probable outcome; a record that disagrees with its own
  // distribution is not a classification.
  return record.probabilities[record.selected] === maximum ? record.selected : null;
}

function dispositionOutcome(
  finding: SettleableReviewFinding,
  category: SettledFindingCategory,
  disposition: ReviewFindingDisposition,
  hardRule: boolean,
): SettledReviewFinding {
  switch (disposition) {
    case "blocker":
      return settled(finding, category, "blocked", disposition, hardRule, "Triaged as a blocker for this cut.");
    case "non_blocking":
      return settled(
        finding,
        category,
        "follow_up_owned",
        disposition,
        hardRule,
        "Triaged as real but not this cut's blocker; the owner receives a follow-up task.",
      );
    case "pre_existing":
      return settled(
        finding,
        category,
        "follow_up_owned",
        disposition,
        hardRule,
        "Pre-existing before this cut; a follow-up task owns it and this cut is not blamed.",
      );
    case "nit":
      return settled(finding, category, "closed", disposition, hardRule, "Nit; recorded and closed.");
    case "false_positive":
      return settled(
        finding,
        category,
        "closed",
        disposition,
        hardRule,
        "Not reproducible on the frozen evidence; closed as a false positive.",
      );
  }
}

function settled(
  finding: SettleableReviewFinding,
  category: SettledFindingCategory,
  outcome: ReviewFindingOutcome,
  disposition: ReviewFindingDisposition | null,
  hardRule: boolean,
  reason: string,
): SettledReviewFinding {
  return { reviewId: finding.reviewId, findingId: finding.findingId, category, outcome, disposition, hardRule, reason };
}

/** Shape validation for a triage record the center receives from the Decision API. */
export function validateReviewFindingTriageV1(value: unknown): readonly ContractValidationIssue[] {
  const issue = (message: string): readonly ContractValidationIssue[] => [
    { code: "invalid_review_finding_triage", message },
  ];
  if (typeof value !== "object" || value === null) return issue("triage must be an object");
  const record = value as Readonly<Record<string, unknown>>;
  if (record.schema !== "review-finding-triage/v1") return issue("triage schema must be review-finding-triage/v1");
  if (![record.reviewId, record.findingId, record.model].every(isNonEmptyString))
    return issue("triage must name the review, finding, and model");
  if (!digest(record.targetDigest) || !digest(record.bindingDigest))
    return issue("triage must bind the target digest and the Decision point binding digest");
  if (!(reviewFindingDispositions as readonly string[]).includes(String(record.selected)))
    return issue("triage selected an unknown disposition");
  if (!validProbabilities(record.probabilities)) return issue("triage probabilities must cover all five dispositions");
  if (typeof record.decidedAt !== "string" || Number.isNaN(Date.parse(record.decidedAt)))
    return issue("triage must carry a decidedAt timestamp");
  if (record.critic !== undefined) {
    const critic = record.critic as Readonly<Record<string, unknown>>;
    if (typeof critic !== "object" || critic === null) return issue("triage critic must be an object");
    if (!(reviewFindingDispositions as readonly string[]).includes(String(critic.selected)))
      return issue("triage critic selected an unknown disposition");
    if (!validProbabilities(critic.probabilities))
      return issue("triage critic probabilities must cover all five dispositions");
    if (![critic.model, critic.bindingDigest].every((field) => typeof field === "string" && field.length > 0))
      return issue("triage critic must name its model and binding digest");
  }
  return [];
}

function validProbabilities(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return reviewFindingDispositions.every((disposition) => {
    const probability = record[disposition];
    return typeof probability === "number" && probability >= 0 && probability <= 1;
  });
}
