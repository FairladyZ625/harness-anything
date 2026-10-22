import type { ProductionDeltaV1, SubmissionV1 } from "./execution.ts";

export const DELETED_OUTPUT_PREFIX = "Deleted-Production-Paths: ";

export type SubmissionFacts =
  | {
      readonly kind: "frozen";
      readonly changedFiles: readonly string[];
      readonly productionDelta: ProductionDeltaV1;
    }
  | {
      readonly kind: "legacy";
      readonly changedFiles: readonly string[];
      readonly productionDelta: null;
    }
  | {
      readonly kind: "artifact-only";
      readonly changedFiles: readonly [];
      readonly productionDelta: null;
    };

/**
 * One read port for delivery facts. Historical Submission/v1 rows predate the optional facts;
 * their stored deliverables and deleted-path outputs are evidence, not a newly calculated Git cut.
 */
export function readSubmissionFacts(submission: SubmissionV1): SubmissionFacts {
  if (submission.commitSha === null) return { kind: "artifact-only", changedFiles: [], productionDelta: null };
  const changedFiles = submission.changedFiles ?? [
    ...submission.deliverables,
    ...submission.outputs
      .filter((output) => output.startsWith(DELETED_OUTPUT_PREFIX))
      .map((output) => output.slice(DELETED_OUTPUT_PREFIX.length)),
  ];
  const normalized = [...new Set(changedFiles)].sort();
  if (submission.changedFiles !== undefined && submission.productionDelta !== undefined)
    return { kind: "frozen", changedFiles: normalized, productionDelta: submission.productionDelta };
  return { kind: "legacy", changedFiles: normalized, productionDelta: null };
}
