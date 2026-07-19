import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  computeDecisionContentDigest,
  decisionContentCanonicalization,
  decisionContentDigestFields,
  parseDecisionDocument,
  resolveHarnessLayout,
  type DecisionContentDigestField,
  type DecisionPackage,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

export const decisionContentPinVerificationSchema = "decision-content-pin-verification-report/v1" as const;

export { decisionContentDigestFields };
export type { DecisionContentDigestField };

export interface DecisionContentPinGitChange {
  readonly commit: string;
  readonly subject: string;
  readonly changedFields: ReadonlyArray<DecisionContentDigestField>;
}

export interface DecisionContentPinWarning {
  readonly code: "decision_content_pin_mismatch" | "decision_content_pin_canonicalization_unsupported";
  readonly decisionId: string;
  readonly path: string;
  readonly canonicalization: string;
  readonly recordedDigest: string;
  readonly recomputedDigest?: string;
  readonly changedFields: ReadonlyArray<DecisionContentDigestField>;
  readonly gitChanges: ReadonlyArray<DecisionContentPinGitChange>;
  readonly message: string;
}

export interface DecisionContentPinVerificationReport {
  readonly schema: typeof decisionContentPinVerificationSchema;
  readonly checkedDecisionCount: number;
  readonly pinnedDecisionCount: number;
  readonly matchCount: number;
  readonly mismatchCount: number;
  readonly unpinnedDecisionCount: number;
  readonly warnings: ReadonlyArray<DecisionContentPinWarning>;
}

export interface DecisionContentPinVerificationOptions {
  readonly decisionIds?: ReadonlyArray<string>;
}

interface GitHistoryEntry {
  readonly commit: string;
  readonly subject: string;
}

export function verifyDecisionContentPins(
  rootInput: HarnessLayoutInput,
  options: DecisionContentPinVerificationOptions = {}
): DecisionContentPinVerificationReport {
  const layout = resolveHarnessLayout(rootInput);
  if (!existsSync(layout.decisionsRoot)) {
    return {
      schema: decisionContentPinVerificationSchema,
      checkedDecisionCount: 0,
      pinnedDecisionCount: 0,
      matchCount: 0,
      mismatchCount: 0,
      unpinnedDecisionCount: 0,
      warnings: []
    };
  }
  const selectedIds = options.decisionIds ? new Set(options.decisionIds) : undefined;
  const paths = readdirSync(layout.decisionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("decision-"))
    .map((entry) => ({
      decisionId: entry.name.slice("decision-".length),
      documentPath: path.join(layout.decisionsRoot, entry.name, "decision.md")
    }))
    .filter((entry) => (!selectedIds || selectedIds.has(entry.decisionId)) && existsSync(entry.documentPath))
    .toSorted((left, right) => left.decisionId.localeCompare(right.decisionId));
  const warnings: DecisionContentPinWarning[] = [];
  let pinnedDecisionCount = 0;
  let matchCount = 0;
  let unpinnedDecisionCount = 0;

  for (const entry of paths) {
    let decision: DecisionPackage;
    try {
      decision = parseDecisionDocument(readFileSync(entry.documentPath, "utf8")).decision;
    } catch {
      // Structural validation is owned by the surrounding check profile. The pin
      // verifier must not turn an already-invalid legacy document into a CLI crash.
      unpinnedDecisionCount += 1;
      continue;
    }
    const pin = decision.contentPins?.at(-1);
    if (!pin) {
      unpinnedDecisionCount += 1;
      continue;
    }
    pinnedDecisionCount += 1;
    const recomputedDigest = digestForCanonicalization(pin.canonicalization, decision);
    const relativePath = path.relative(layout.rootDir, entry.documentPath).split(path.sep).join("/");
    if (!recomputedDigest) {
      warnings.push({
        code: "decision_content_pin_canonicalization_unsupported",
        decisionId: decision.decision_id,
        path: relativePath,
        canonicalization: pin.canonicalization,
        recordedDigest: pin.digest,
        changedFields: [],
        gitChanges: [],
        message: `decision ${decision.decision_id} content pin uses unsupported canonicalization ${pin.canonicalization}`
      });
      continue;
    }
    if (recomputedDigest === pin.digest) {
      matchCount += 1;
      continue;
    }
    const trace = traceDecisionContentChanges(entry.documentPath, decision, pin.digest);
    warnings.push({
      code: "decision_content_pin_mismatch",
      decisionId: decision.decision_id,
      path: relativePath,
      canonicalization: pin.canonicalization,
      recordedDigest: pin.digest,
      recomputedDigest,
      changedFields: trace.changedFields,
      gitChanges: trace.gitChanges,
      message: mismatchMessage(decision.decision_id, trace.changedFields, trace.gitChanges)
    });
  }

  return {
    schema: decisionContentPinVerificationSchema,
    checkedDecisionCount: paths.length,
    pinnedDecisionCount,
    matchCount,
    mismatchCount: warnings.length,
    unpinnedDecisionCount,
    warnings
  };
}

function digestForCanonicalization(canonicalization: string, decision: DecisionPackage): string | undefined {
  switch (canonicalization) {
    case decisionContentCanonicalization:
      return computeDecisionContentDigest(decision);
    default:
      return undefined;
  }
}

function traceDecisionContentChanges(
  documentPath: string,
  current: DecisionPackage,
  recordedDigest: string
): { readonly changedFields: ReadonlyArray<DecisionContentDigestField>; readonly gitChanges: ReadonlyArray<DecisionContentPinGitChange> } {
  const discoveredRoot = gitStdout(path.dirname(documentPath), ["rev-parse", "--show-toplevel"])?.trim();
  if (!discoveredRoot) return { changedFields: [], gitChanges: [] };
  const repositoryRoot = realpathSync(discoveredRoot);
  const relativePath = path.relative(repositoryRoot, realpathSync(documentPath)).split(path.sep).join("/");
  const history = readGitHistory(repositoryRoot, relativePath);
  const versions = history.map((entry) => readDecisionAtRevision(repositoryRoot, relativePath, entry.commit));
  const baselineIndex = versions.findIndex((decision) => decision && computeDecisionContentDigest(decision) === recordedDigest);
  const baseline = baselineIndex >= 0 ? versions[baselineIndex] : undefined;
  if (!baseline) return { changedFields: [], gitChanges: [] };
  const changedFields = changedDecisionContentFields(baseline, current);
  const changedFieldSet = new Set<DecisionContentDigestField>(changedFields);
  const gitChanges: DecisionContentPinGitChange[] = [];
  let previous = baseline;

  for (let index = baselineIndex - 1; index >= 0; index -= 1) {
    const next = versions[index];
    const historyEntry = history[index];
    if (!next || !historyEntry) continue;
    const fields = changedDecisionContentFields(previous, next).filter((field) => changedFieldSet.has(field));
    if (fields.length > 0) {
      gitChanges.push({ commit: historyEntry.commit, subject: historyEntry.subject, changedFields: fields });
    }
    previous = next;
  }

  const worktreeFields = changedDecisionContentFields(previous, current).filter((field) => changedFieldSet.has(field));
  if (worktreeFields.length > 0) {
    gitChanges.push({ commit: "WORKTREE", subject: "uncommitted decision document change", changedFields: worktreeFields });
  }
  return { changedFields, gitChanges };
}

function readGitHistory(repositoryRoot: string, relativePath: string): ReadonlyArray<GitHistoryEntry> {
  const output = gitStdout(repositoryRoot, ["log", "--format=%H%x00%s%x00", "--", relativePath]);
  if (!output) return [];
  const parts = output.split("\0").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const entries: GitHistoryEntry[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    entries.push({ commit: parts[index] ?? "", subject: parts[index + 1] ?? "" });
  }
  return entries;
}

function readDecisionAtRevision(repositoryRoot: string, relativePath: string, commit: string): DecisionPackage | undefined {
  const document = gitStdout(repositoryRoot, ["show", `${commit}:${relativePath}`]);
  if (!document) return undefined;
  try {
    return parseDecisionDocument(document).decision;
  } catch {
    return undefined;
  }
}

function changedDecisionContentFields(
  previous: DecisionPackage,
  next: DecisionPackage
): ReadonlyArray<DecisionContentDigestField> {
  return decisionContentDigestFields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
}

function mismatchMessage(
  decisionId: string,
  changedFields: ReadonlyArray<DecisionContentDigestField>,
  gitChanges: ReadonlyArray<DecisionContentPinGitChange>
): string {
  const fields = changedFields.length > 0 ? changedFields.join(", ") : "unknown";
  const commits = gitChanges.length > 0
    ? gitChanges.map((entry) => `${entry.commit === "WORKTREE" ? entry.commit : entry.commit.slice(0, 12)} (${entry.changedFields.join(", ")})`).join(", ")
    : "unavailable";
  return `decision ${decisionId} content pin mismatch; changed fields: ${fields}; git changes: ${commits}`;
}

function gitStdout(cwd: string, args: ReadonlyArray<string>): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
}
