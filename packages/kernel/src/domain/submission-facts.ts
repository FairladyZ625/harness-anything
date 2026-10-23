import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import type { ProductionDeltaV1, SubmissionV1 } from "./execution.ts";

export const DELETED_OUTPUT_PREFIX = "Deleted-Production-Paths: ";

export const historicalReadConclusions = Object.freeze([
  {
    kind: "read-conclusion",
    name: "submission.delivery-facts",
    fields: ["Execution.submission.changedFiles", "Execution.submission.productionDelta"],
    attachRequired: false,
    conclusion:
      "Legacy rows remain byte-identical; the shared submission-facts reader exposes unambiguous stored paths and no production delta.",
  },
] as const);

/** Historical Submission/v1 rows have path prose but no frozen G33 facts to replay. */
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
      readonly pathEvidence: "complete" | "partial" | "unavailable";
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
  if (submission.changedFiles !== undefined && submission.productionDelta !== undefined)
    return {
      kind: "frozen",
      changedFiles: [...new Set(submission.changedFiles)].sort(),
      productionDelta: submission.productionDelta,
    };
  const storedPaths = [
    ...submission.deliverables,
    ...submission.outputs
      .filter((output) => output.startsWith(DELETED_OUTPUT_PREFIX))
      .map((output) => output.slice(DELETED_OUTPUT_PREFIX.length)),
  ];
  const changedFiles = storedPaths.filter(isUnambiguousLegacyPath),
    pathEvidence =
      storedPaths.length > 0 && changedFiles.length === storedPaths.length
        ? "complete"
        : changedFiles.length === 0
          ? "unavailable"
          : "partial";
  return { kind: "legacy", changedFiles: [...new Set(changedFiles)].sort(), productionDelta: null, pathEvidence };
}

/** Legacy free-form deliverables are path evidence only when they have an unambiguous path shape. */
function isUnambiguousLegacyPath(value: string): boolean {
  if (value.trim() !== value || /\s/u.test(value)) return false;
  try {
    const normalized = normalizeRelativeDocumentPath(value),
      basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return normalized.includes("/") || basename.includes(".");
  } catch {
    return false;
  }
}
