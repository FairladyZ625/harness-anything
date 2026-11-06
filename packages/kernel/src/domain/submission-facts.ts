import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import type { ProductionDeltaV1, SubmissionV1 } from "./execution.ts";

export const DELETED_OUTPUT_PREFIX = "Deleted-Production-Paths: ";

/** The one machine-owned delivery-facts region in a PR body. */
export const SUBMISSION_FACTS_START = "<!-- harness:submission-facts:start -->",
  SUBMISSION_FACTS_END = "<!-- harness:submission-facts:end -->";

export const historicalReadConclusions = Object.freeze([
  {
    kind: "read-conclusion",
    name: "submission.delivery-facts",
    fields: ["Execution.submission.changedFiles", "Execution.submission.productionDelta"],
    attachRequired: false,
    conclusion:
      "Legacy rows remain byte-identical; the shared submission-facts reader exposes unambiguous stored paths and no production delta.",
  },
  {
    kind: "read-conclusion",
    name: "review.finding.category",
    fields: ["Review.findings[].category", "DecisionReview.findings[].category"],
    attachRequired: false,
    conclusion:
      "Findings written before this field existed stay byte-identical and are never backfilled: a " +
      "submission/content digest pins a cut, so rewriting a finding would change an accepted cut's " +
      "identity. Findings remain report content; the current review verdict and owner consent decide " +
      "completion, while historical disposition records remain readable without migration.",
  },
  {
    kind: "read-conclusion",
    name: "task.packageDisposition",
    fields: ["Task.packageDisposition"],
    attachRequired: false,
    conclusion:
      "A task whose history never stated packageDisposition reads as active, the same answer the " +
      "projection's generated package_disposition column gives. Stored snapshots stay byte-identical " +
      "and are never backfilled or replayed; a stated or illegal value is never overridden.",
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

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function submittedPaths(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
    throw new Error(`submitted cut has an invalid ${name} list`);
  return [...new Set(value)].sort();
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function pathCode(value: string): string {
  const encoded = JSON.stringify(value),
    longestTickRun = Math.max(0, ...(encoded.match(/`+/gu) ?? []).map((run) => run.length)),
    delimiter = "`".repeat(longestTickRun + 1);
  return `${delimiter}${encoded}${delimiter}`;
}

/** The single machine rendering of frozen delivery facts; the renderer and every publication use it. */
export function renderSubmissionFacts(
  submission: SubmissionV1,
  facts: SubmissionFacts = readSubmissionFacts(submission),
): string {
  if (submission.commitSha === null) {
    const artifacts = submittedPaths(submission.deliverables, "deliverables");
    return [
      "## Delivery Facts",
      "- Delivery: artifact-only; no public Git commit.",
      `- Delivered artifacts: ${String(artifacts.length)} center-accepted artifact(s); ` +
        "paths remain in the private submission record.",
    ].join("\n");
  }
  if (!isSha(submission.commitSha)) throw new Error("submitted cut has an invalid delivery commit SHA");
  const files = submittedPaths(facts.changedFiles, "changedFiles");
  if (facts.kind === "legacy")
    return [
      "## Delivery Facts",
      `- Delivery commit: ${inlineCode(submission.commitSha)}`,
      "- Legacy submission facts: this historical cut predates frozen changedFiles and productionDelta.",
      "- Changed paths (stored delivery evidence):",
      ...(files.length ? files.map((filePath) => `  - ${pathCode(filePath)}`) : ["  - none"]),
      "- Production delta: unavailable on this legacy cut.",
    ].join("\n");
  const delta = facts.productionDelta;
  if (
    !record(delta) ||
    !isSha(delta.baseSha) ||
    !Number.isSafeInteger(delta.added) ||
    (delta.added as number) < 0 ||
    !Number.isSafeInteger(delta.deleted) ||
    (delta.deleted as number) < 0 ||
    !Array.isArray(delta.changed) ||
    !delta.changed.every((entry) => record(entry) && typeof entry.filePath === "string") ||
    !Array.isArray(delta.unclassified) ||
    !delta.unclassified.every((entry) => typeof entry === "string")
  )
    throw new Error("submitted code cut has no valid frozen productionDelta");
  const added = delta.added as number,
    deleted = delta.deleted as number,
    net = added - deleted,
    unclassified = delta.unclassified.length
      ? ["- G33 unclassified production paths:", ...delta.unclassified.map((entry) => `  - ${pathCode(entry)}`)]
      : ["- G33 classification: complete."],
    changed = files.length ? files.map((filePath) => `  - ${pathCode(filePath)}`) : ["  - none"];
  return [
    "## Delivery Facts",
    `- Delivery commit: ${inlineCode(submission.commitSha)}`,
    `- Merge base: ${inlineCode(delta.baseSha)}`,
    `- Production delta: +${String(added)}/-${String(deleted)} (net ${net >= 0 ? "+" : ""}${String(net)}).`,
    "- Changed files:",
    ...changed,
    ...unclassified,
  ].join("\n");
}

/** Replace the machine-owned facts region of an existing body; null when it has no single marker pair. */
export function replaceSubmissionFacts(body: string, block: string): string | null {
  const start = body.indexOf(SUBMISSION_FACTS_START),
    end = body.indexOf(SUBMISSION_FACTS_END);
  if (
    start < 0 ||
    end < 0 ||
    start >= end ||
    body.indexOf(SUBMISSION_FACTS_START, start + SUBMISSION_FACTS_START.length) >= 0 ||
    body.indexOf(SUBMISSION_FACTS_END, end + SUBMISSION_FACTS_END.length) >= 0
  )
    return null;
  return `${body.slice(0, start + SUBMISSION_FACTS_START.length)}\n${block}\n${body.slice(end)}`;
}
