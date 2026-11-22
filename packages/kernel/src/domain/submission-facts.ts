import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import type { ProductionDeltaV1, SubmissionV1 } from "./execution.ts";
import { submissionDigest } from "./submission-digest.ts";

export const DELETED_OUTPUT_PREFIX = "Deleted-Production-Paths: ";

/** The one machine-owned delivery-facts region in a PR body. */
export const SUBMISSION_FACTS_START = "<!-- harness:submission-facts:start -->",
  SUBMISSION_FACTS_END = "<!-- harness:submission-facts:end -->";

/** The one machine-owned delivery-facts region maintained in closeout.md on submit/amend. */
export const CLOSEOUT_FACTS_START = "<!-- harness:closeout-facts:start -->",
  CLOSEOUT_FACTS_END = "<!-- harness:closeout-facts:end -->";

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
      "Tasks imported before the importer defaulted this field stay byte-identical in events and " +
      "projection snapshots; daemon task reads conclude active for a task whose history never stated " +
      "a disposition, the same answer as the projection's generated package_disposition column " +
      "(taskPackageDisposition).",
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

// PR paths are a display projection; the frozen submission keeps the authoritative full lists.
// Bound encoded UTF-16 characters too: 150 long paths can still exceed GitHub's 65,536 limit.
const MAX_INLINE_CHANGED_FILES = 150,
  MAX_INLINE_PATH_CHARACTERS = 16_000;

function renderInlinePaths(paths: readonly string[], omittedDescription: string): readonly string[] {
  const lines: string[] = [];
  let characters = 0;
  for (const filePath of paths.slice(0, MAX_INLINE_CHANGED_FILES)) {
    const line = `  - ${pathCode(filePath)}`;
    if (characters + line.length + 1 > MAX_INLINE_PATH_CHARACTERS) break;
    lines.push(line);
    characters += line.length + 1;
  }
  const remaining = paths.length - lines.length;
  if (remaining > 0) lines.push(`  - ... (${remaining} more ${omittedDescription})`);
  return paths.length ? lines : ["  - none"];
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
      ...renderInlinePaths(files, `files in commit diff; total ${files.length} changed files`),
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
      ? [
          "- G33 unclassified production paths:",
          ...renderInlinePaths(
            delta.unclassified.length > MAX_INLINE_CHANGED_FILES ? [...delta.unclassified].sort() : delta.unclassified,
            `unclassified paths; total ${delta.unclassified.length} unclassified paths`,
          ),
        ]
      : ["- G33 classification: complete."],
    changed = renderInlinePaths(files, `files in commit diff; total ${files.length} changed files`);
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

type StandaloneFactsBounds =
  | { readonly kind: "none" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "pair";
      readonly startLineStart: number;
      readonly startLineEnd: number;
      readonly endLineStart: number;
      readonly endLineEnd: number;
    };

/**
 * Locate standalone closeout-facts marker lines outside fenced code blocks so prose mentioning
 * the marker text inline or in examples is never mistaken for the machine-owned block.
 */
function standaloneCloseoutFactsBounds(body: string): StandaloneFactsBounds {
  let offset = 0,
    fence: { marker: string; length: number } | null = null;
  const starts: { start: number; end: number }[] = [],
    ends: { start: number; end: number }[] = [];
  for (const rawLine of body.split(/(?<=\n)/u)) {
    const lineStart = offset,
      lineEnd = offset + rawLine.length,
      trimmed = rawLine.replace(/\r?\n$/u, "");
    offset = lineEnd;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(trimmed);
    if (fence === null && delimiter) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      continue;
    }
    if (fence !== null) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.length &&
        !delimiter[2]!.trim()
      )
        fence = null;
      continue;
    }
    const candidate = trimmed.trimEnd();
    if (candidate === CLOSEOUT_FACTS_START) starts.push({ start: lineStart, end: lineEnd });
    else if (candidate === CLOSEOUT_FACTS_END) ends.push({ start: lineStart, end: lineEnd });
  }
  if (starts.length === 0 && ends.length === 0) return { kind: "none" };
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.start >= ends[0]!.start) return { kind: "malformed" };
  return {
    kind: "pair",
    startLineStart: starts[0]!.start,
    startLineEnd: starts[0]!.end,
    endLineStart: ends[0]!.start,
    endLineEnd: ends[0]!.end,
  };
}

/** Closeout mechanical delivery facts: the shared PR facts block plus the frozen submission digest. */
export function renderCloseoutSubmissionFacts(
  submission: SubmissionV1,
  facts: SubmissionFacts = readSubmissionFacts(submission),
): string {
  return [
    renderSubmissionFacts(submission, facts),
    `- Submission digest: ${inlineCode(submissionDigest(submission))}`,
  ].join("\n");
}

/** Remove the standalone managed closeout-facts block so prose readers observe only authored text. */
export function stripCloseoutFactsRegion(body: string): string {
  const bounds = standaloneCloseoutFactsBounds(body);
  if (bounds.kind !== "pair") return body;
  const before = body.slice(0, bounds.startLineStart).replace(/(?:[ \t]*\r?\n)+$/u, ""),
    after = body.slice(bounds.endLineEnd).replace(/^(?:[ \t]*\r?\n)+/u, "");
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/** Idempotently insert or refresh the managed delivery-facts region of closeout.md, keeping authored prose intact. */
export function upsertCloseoutSubmissionFacts(closeout: string, submission: SubmissionV1): string {
  const bounds = standaloneCloseoutFactsBounds(closeout),
    block = renderCloseoutSubmissionFacts(submission);
  if (bounds.kind === "malformed")
    throw new Error("closeout must contain at most one ordered closeout-facts marker pair");
  if (bounds.kind === "pair") {
    const startLine = closeout.slice(bounds.startLineStart, bounds.startLineEnd).replace(/\r?\n$/u, ""),
      suffix = closeout.slice(bounds.endLineStart);
    return `${closeout.slice(0, bounds.startLineStart)}${startLine}\n${block}\n${suffix}`;
  }
  const trimmed = closeout.replace(/\s+$/u, ""),
    managed = `${CLOSEOUT_FACTS_START}\n${block}\n${CLOSEOUT_FACTS_END}\n`;
  return trimmed.length > 0 ? `${trimmed}\n\n${managed}` : managed;
}
