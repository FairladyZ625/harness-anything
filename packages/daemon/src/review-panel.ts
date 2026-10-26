/**
 * The one review-panel seat decision for a submitted cut (dec_6A77D43B8523823ABA1F5E4D3C CH1).
 *
 * A cut has exactly one seat by default. The repository's `roles.defaultReviewer` picks the
 * identity; a professional path reviewer whose configured path the frozen delivery touches
 * *replaces* that default seat instead of opening a second, independently passing review gate.
 * An owner's explicit `--agent` and a task's own reviewer override come first because both are
 * narrower declarations made before the cut is reviewed.
 *
 * Both the automatic dispatch after submit and `ha task dispatch-review` call this function, so a
 * cancelled or failed seat can be re-dispatched alone instead of the two paths disagreeing about
 * which reviewers a cut holds.
 */

/** Where the seated reviewer came from, most specific first. */
export type ReviewSeatSource = "argument" | "task" | "path" | "frozen" | "settings" | "bundled";

export interface ReviewPathHit {
  readonly agentId: string;
  readonly paths: readonly string[];
}

export interface ReviewSeat {
  readonly reviewerId: string;
  readonly source: ReviewSeatSource;
  /** The paths that put a professional reviewer in the seat; absent for a default seat. */
  readonly matchedPaths?: readonly string[];
}

export type ReviewSeatSelection =
  | { readonly kind: "seat"; readonly seat: ReviewSeat }
  /** A cut that touches two professional reviewers cannot silently drop one of them. */
  | { readonly kind: "escalated"; readonly reason: string; readonly reviewers: readonly string[] };

export function selectReviewSeat(input: {
  readonly argument?: string | undefined;
  readonly taskReviewer?: string | undefined;
  readonly frozenReviewer?: string | undefined;
  readonly repositoryDefault?: string | undefined;
  readonly pathReviewers?: readonly ReviewPathHit[] | undefined;
}): ReviewSeatSelection {
  if (input.argument) return { kind: "seat", seat: { reviewerId: input.argument, source: "argument" } };
  if (input.taskReviewer) return { kind: "seat", seat: { reviewerId: input.taskReviewer, source: "task" } };
  const hits = [...(input.pathReviewers ?? [])]
    .filter(({ agentId }) => agentId.length > 0)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  if (hits.length > 1)
    return {
      kind: "escalated",
      reason:
        `This cut matches ${String(hits.length)} professional path reviewers (${hits
          .map(({ agentId }) => agentId)
          .join(", ")}). The panel holds one seat; a person must choose which professional review ` +
        "the cut needs before it is dispatched.",
      reviewers: hits.map(({ agentId }) => agentId),
    };
  if (hits.length === 1) {
    const [hit] = hits;
    return {
      kind: "seat",
      seat: { reviewerId: hit!.agentId, source: "path", matchedPaths: [...hit!.paths] },
    };
  }
  if (input.frozenReviewer) return { kind: "seat", seat: { reviewerId: input.frozenReviewer, source: "frozen" } };
  if (input.repositoryDefault)
    return { kind: "seat", seat: { reviewerId: input.repositoryDefault, source: "settings" } };
  return { kind: "seat", seat: { reviewerId: "closeout-reviewer", source: "bundled" } };
}
