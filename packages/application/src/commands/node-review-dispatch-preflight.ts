import type { TaskReviewDispatchFailureV1 } from "@harness-anything/kernel";

interface ReviewCandidate {
  readonly taskId: string;
  readonly executionId: string;
  readonly dispatchKey: string;
}

/** Observe the same runtime preflight before returning an accepted node-owned review intent.
 * The submission stays accepted; its review failure is published through the existing Task action.
 * Network/process work belongs to the injected ports, outside the center's writer queue. */
export async function preflightNodeReviewDispatch(input: {
  readonly candidates: readonly ReviewCandidate[];
  readonly preflight: () => Promise<void>;
  readonly diagnostic: (error: unknown) => { readonly code: string; readonly message: string };
  readonly writeFailure: (candidate: ReviewCandidate, failure: TaskReviewDispatchFailureV1) => Promise<void>;
  readonly now: () => string;
}): Promise<{
  readonly failures: readonly TaskReviewDispatchFailureV1[];
  readonly publicationWarnings: readonly string[];
}> {
  if (input.candidates.length === 0) return { failures: [], publicationWarnings: [] };
  try {
    await input.preflight();
  } catch (error) {
    const diagnostic = input.diagnostic(error),
      failures: TaskReviewDispatchFailureV1[] = [],
      publicationWarnings: string[] = [];
    for (const candidate of input.candidates) {
      const failure = {
        executionId: candidate.executionId,
        dispatchKey: candidate.dispatchKey,
        ...diagnostic,
        failedAt: input.now(),
      };
      failures.push(failure);
      const publicationWarning = await input.writeFailure(candidate, failure).then(
        () => null,
        (publicationError: unknown) => {
          const publication = input.diagnostic(publicationError);
          return `Task ${candidate.taskId} could not record review dispatch failure: ${publication.code}; ${publication.message}`;
        },
      );
      if (publicationWarning !== null) publicationWarnings.push(publicationWarning);
    }
    return { failures, publicationWarnings };
  }
  return { failures: [], publicationWarnings: [] };
}
