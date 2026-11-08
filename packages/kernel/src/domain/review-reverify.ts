import type { ExecutionV1 } from "./execution.ts";
import type { ContractValidationIssue } from "./task.ts";
import type {
  ReviewFindingCategory,
  ReviewFindingV1,
  ReviewReverifyMode,
  ReviewV1,
  TaskReviewResponseV1,
} from "./review.ts";

/**
 * dec_BEFCF7D0484E901F187C2C8EC6 CH1: the finding categories whose fix the task owner may verify —
 * evidence and counts, wording and naming, test- or tool-output-only, and the non-settling notes.
 * Every other category (production behavior, authorization, data, migration, concurrency,
 * external protocol, decision breaks, completeness) is load-bearing and only `re-review` applies.
 */
export const ownerVerifiableFindingCategories = Object.freeze([
  "evidence",
  "wording",
  "test-only",
  "style",
  "diagnostic",
  "cleanup",
] as const satisfies readonly ReviewFindingCategory[]);

/** An absent reverify is a reviewer who was unsure: it reads as `re-review`. */
export function findingReverify(finding: Pick<ReviewFindingV1, "reverify">): ReviewReverifyMode {
  return finding.reverify ?? "re-review";
}

/** The writing-boundary check: a load-bearing category can never be released to owner verification. */
export function reviewFindingReverifyIssues(findings: readonly ReviewFindingV1[]): readonly ContractValidationIssue[] {
  return findings
    .filter(
      (finding) =>
        finding.reverify === "owner-verify" &&
        !(ownerVerifiableFindingCategories as readonly string[]).includes(finding.category ?? "correctness"),
    )
    .map((finding) => ({
      code: "invalid_review",
      message:
        `finding ${finding.findingId} is ${finding.category ?? "correctness"}; only ` +
        `${ownerVerifiableFindingCategories.join(", ")} findings may use reverify owner-verify`,
    }));
}

export interface ReviewReverifyFinding {
  readonly reviewId: string;
  readonly finding: ReviewFindingV1;
  readonly reverify: ReviewReverifyMode;
  /** The implementer adopted the finding in a review response. */
  readonly adopted: boolean;
}

/**
 * What the current submitted cut needs after the previous review round (dec_BEFCF7D0 CH2/CH3):
 *  - `full`: no previous changes_requested round with structured findings — one complete review.
 *  - `owner-verify`: every previous blocking finding is owner-verify and adopted — no reviewer is
 *    dispatched; the owner consents citing one of `reviews` with a verification note.
 *  - `re-review`: a scoped re-review of `pending` findings only, against the diff since `sinceCommit`.
 * Non-blocking findings never enter the route.
 */
export type ReviewReverifyRoute =
  | { readonly kind: "full" }
  | {
      readonly kind: "owner-verify";
      readonly reviews: readonly ReviewV1[];
      readonly findings: readonly ReviewReverifyFinding[];
    }
  | {
      readonly kind: "re-review";
      readonly reviews: readonly ReviewV1[];
      readonly findings: readonly ReviewReverifyFinding[];
      readonly pending: readonly ReviewReverifyFinding[];
      readonly sinceCommit: string | null;
    };

export function reviewReverifyRoute(input: {
  readonly reviews: readonly ReviewV1[];
  readonly reviewResponses: readonly TaskReviewResponseV1[] | undefined;
  readonly execution: Pick<ExecutionV1, "iteration">;
}): ReviewReverifyRoute {
  const earlier = input.reviews.filter((review) => review.iteration < input.execution.iteration);
  if (earlier.length === 0) return { kind: "full" };
  const round = Math.max(...earlier.map((review) => review.iteration)),
    reviews = earlier.filter((review) => review.iteration === round && review.verdict === "changes_requested");
  if (reviews.length === 0 || reviews.some((review) => review.findings === undefined)) return { kind: "full" };
  const adopted = new Set(
      (input.reviewResponses ?? [])
        .filter((response) => response.disposition === "adopt")
        .map((response) => `${response.reviewId}\0${response.findingId}`),
    ),
    findings: ReviewReverifyFinding[] = reviews.flatMap((review) =>
      (review.findings ?? [])
        .filter(
          (finding) =>
            finding.blocking &&
            !(review.resolutions ?? []).some(
              (resolution) =>
                resolution.reviewId === review.reviewId &&
                resolution.findingId === finding.findingId &&
                resolution.resolution === "withdrawn",
            ),
        )
        .map((finding) => ({
          reviewId: review.reviewId,
          finding,
          reverify: findingReverify(finding),
          adopted: adopted.has(`${review.reviewId}\0${finding.findingId}`),
        })),
    );
  if (findings.length === 0) return { kind: "full" };
  const pending = findings.filter((item) => item.reverify === "re-review" || !item.adopted);
  if (pending.length === 0) return { kind: "owner-verify", reviews, findings };
  return {
    kind: "re-review",
    reviews,
    findings,
    pending,
    sinceCommit: [...reviews].sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt)).at(-1)!.commitSha,
  };
}
