import {
  cutReviewFindings,
  reviewFindingThresholdsFor,
  submissionDigest,
  type ExecutionV1,
  type ReviewFindingSettlement,
  type ReviewFindingThresholds,
  type ReviewV1,
} from "@harness-anything/kernel";
import type { DecisionProviderRecord } from "@harness-anything/kernel";
import type { DecisionPort } from "./decision-provider.ts";
import { reviewFindingTriageFor, type ReviewTriageTarget } from "./review-finding-triage.ts";

/**
 * The center's triage producer, wired to the review write (dec_6A77D43B8523823ABA1F5E4D3C CH3/CH5).
 *
 * A review that lands with categorized findings must produce their triage records, or the closeout
 * gate has nothing to read and every such cut escalates rather than settling. The write path cannot
 * do this itself — the Decisions provider lives on the host, and the cell may not call it — so the
 * host drives this after the review is applied.
 *
 * The target digest is the *cut's* submission digest, the same value `reviewsForExecution` pins a
 * review to. That is what makes a record answer for exactly one cut: an amend mints a new
 * submission digest and therefore needs its own answers.
 */
/**
 * The repository's per-category confidence floors, as the fractional thresholds settlement reads.
 *
 * Settings store integer percent so the existing `integer` field kind carries them; the settlement
 * compares probabilities in [0,1]. A repository that sets nothing keeps the decision's floors, which
 * `reviewFindingThresholdsFor` already clamps upward — this only supplies the override.
 */
export function reviewFindingThresholdsFromSettings(
  settings: {
    readonly review?: {
      readonly thresholds?: {
        readonly correctness?: unknown;
        readonly migration?: unknown;
        readonly securityAuth?: unknown;
      };
    };
  } | null,
): ReviewFindingThresholds | undefined {
  if (settings === null) return undefined;
  const percent = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100 ? value / 100 : fallback / 100;
  return {
    correctness: percent(settings.review?.thresholds?.correctness, 80),
    completeness: percent(settings.review?.thresholds?.correctness, 80),
    "ci-required": percent(settings.review?.thresholds?.migration, 85),
    migration: percent(settings.review?.thresholds?.migration, 85),
    "decision-break": percent(settings.review?.thresholds?.migration, 85),
    "security-auth": percent(settings.review?.thresholds?.securityAuth, 90),
    "data-loss": percent(settings.review?.thresholds?.securityAuth, 90),
  };
}

export interface ReviewTriageProducerInput {
  readonly rootDir: string;
  readonly providers: { readonly list: () => readonly DecisionProviderRecord[]; readonly port: DecisionPort };
  readonly now: () => string;
  readonly rulesVersion: string;
  /** The repository's threshold overrides, if a caller already read Settings for this cut. */
  readonly readThresholds?: () => ReviewFindingThresholds | undefined;
}

export function makeReviewTriageProducer(input: ReviewTriageProducerInput) {
  return {
    /**
     * Settle the cut the review landed on. Returns `null` when the cut raised no categorized
     * finding — nothing enters per-finding settlement, and the cut keeps its review verdict.
     *
     * A missing provider is not a silent pass: `settleCut` throws, and the caller records that the
     * cut needs a person. The journal stays unwritten, so the read side keeps escalating it.
     */
    async settleReviewCut(cut: {
      readonly taskId: string;
      readonly execution: ExecutionV1;
      readonly reviews: readonly ReviewV1[];
      readonly thresholds?: unknown;
    }): Promise<ReviewFindingSettlement | null> {
      if (!cut.execution.submission) return null;
      const findings = cutReviewFindings(cut.reviews, cut.execution);
      if (findings.length === 0) return null;
      const target: ReviewTriageTarget = {
        kind: "task",
        id: cut.taskId,
        digest: submissionDigest(cut.execution.submission),
      };
      const { settlement } = await reviewFindingTriageFor({
        rootDir: input.rootDir,
        providers: input.providers,
        now: input.now,
        rulesVersion: input.rulesVersion,
      }).settleCut({
        target,
        findings,
        thresholds: reviewFindingThresholdsFor(
          (cut.thresholds as ReviewFindingThresholds | undefined) ?? input.readThresholds?.(),
        ),
      });
      return settlement;
    },
  };
}
