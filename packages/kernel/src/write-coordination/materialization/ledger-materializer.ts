import path from "node:path";
import { parseAuthorityBatchCommitMessage } from "../../integrity/authority-batch-integrity.ts";
import type { HarnessLayoutInput } from "../../layout/index.ts";
import { resolveHarnessLayout } from "../../layout/index.ts";
import type { VersionControlSystem } from "../../ports/version-control-system.ts";
import { updateTaskProjectionIncrementally } from "../../projection/sqlite-task-incremental-projection.ts";
import type { IncrementalProjectionDiagnostic, IncrementalProjectionPhase } from "../../projection/sqlite-task-incremental-projection.ts";
import { countAttributionProjectionRows } from "../../projection/sqlite-attribution-projection.ts";
import { rebuildTaskProjection } from "../../projection/sqlite-task-projection.ts";
import {
  captureTrustedAuthoredProjectionFingerprint,
  invalidateTrustedAuthoredProjectionFingerprint,
  rememberTrustedAuthoredProjectionFingerprint
} from "../../projection/projection-source-baseline.ts";
import type { TrustedProjectionFingerprintDiagnostic } from "../../projection/projection-source-baseline.ts";
import { makeLocalVersionControlSystem } from "../../persistence/git/local-version-control-system.ts";
import {
  materializerCommitter,
  recoverScriptIngestArtifactConflicts,
  type PreservedMachineArtifact
} from "./machine-artifact-recovery.ts";
import { resolveTrunkBranch, sessionBranchName } from "../journal/publication/git.ts";
import { withRepoLocks } from "../journal/locks.ts";
import type { OwnedLock } from "../journal/types.ts";
import { durableFileExists } from "../journal/durable.ts";
import type { AttributionProjectionDecisionReason } from "../../projection/sqlite-attribution-incremental.ts";
import type { IncrementalProjectionRebuildReason } from "../../projection/projection-change-event.ts";

export interface LedgerMaterializerBranchReport {
  readonly branch: string;
  readonly commitCount: number;
  readonly status: "merged" | "would_merge" | "skipped" | "conflict";
  readonly commits: ReadonlyArray<string>;
  readonly warning?: string;
  readonly nextCommand?: string;
  readonly conflictPaths?: ReadonlyArray<string>;
  readonly preservedArtifacts?: ReadonlyArray<PreservedMachineArtifact>;
}

export interface LedgerMaterializerReport {
  readonly dryRun: boolean;
  readonly merged: number;
  readonly considered: number;
  readonly branches: ReadonlyArray<LedgerMaterializerBranchReport>;
  readonly warnings: ReadonlyArray<string>;
  readonly projectionRebuilt: boolean;
  readonly attributionEventsProjected: number;
}

export interface LedgerMaterializerOptions {
  readonly dryRun?: boolean;
  readonly maxBranches?: number;
  readonly sessionId?: string;
  readonly heldGlobalLock?: OwnedLock;
  readonly versionControlSystem?: VersionControlSystem;
  readonly onProgress?: (step: LedgerMaterializerProgressStep) => void;
  readonly onProjectionPhase?: (phase: IncrementalProjectionPhase) => void;
  readonly onProjectionMode?: (mode: IncrementalTaskProjectionMode, reason?: IncrementalProjectionRebuildReason) => void;
  readonly onProjectionAttributionDecision?: (reason: AttributionProjectionDecisionReason) => void;
  readonly onProjectionDiagnostic?: (
    diagnostic: TrustedProjectionFingerprintDiagnostic | IncrementalProjectionDiagnostic
  ) => void;
}

export type { IncrementalProjectionDiagnostic, IncrementalProjectionPhase };
export type { IncrementalProjectionRebuildReason };

export type IncrementalTaskProjectionMode = "incremental" | "rebuild" | "unchanged";

export type LedgerMaterializerProgressStep =
  | "baseline-start"
  | "baseline-done"
  | "merge-start"
  | "merge-done"
  | "projection-start"
  | "projection-done"
  | "attribution-start"
  | "attribution-done";

const defaultVersionControlSystem = makeLocalVersionControlSystem();

export function runLedgerMaterializer(rootInput: HarnessLayoutInput, options: LedgerMaterializerOptions = {}): LedgerMaterializerReport {
  const layout = resolveHarnessLayout(rootInput);
  const versionControlSystem = options.versionControlSystem ?? defaultVersionControlSystem;
  const repoRoot = versionControlSystem.topLevel(layout.authoredRoot) ?? versionControlSystem.topLevel(layout.rootDir);
  if (!repoRoot) {
    return {
      dryRun: options.dryRun === true,
      merged: 0,
      considered: 0,
      branches: [],
      warnings: ["authored root is not a Git repository"],
      projectionRebuilt: false,
      attributionEventsProjected: 0
    };
  }

  return withRepoLocks(layout.rootDir, rootInput, layout.journalPath, { scope: "operational", kind: "system", id: "ledger-materializer" }, 60_000, [], () => {
    return materializeBranches(
      repoRoot,
      rootInput,
      options.dryRun === true,
      options.maxBranches,
      options.sessionId,
      versionControlSystem,
      options.onProgress,
      options.onProjectionPhase,
      options.onProjectionMode,
      options.onProjectionAttributionDecision,
      options.onProjectionDiagnostic
    );
  }, { heldGlobalLock: options.heldGlobalLock });
}

function materializeBranches(
  repoRoot: string,
  rootInput: HarnessLayoutInput,
  dryRun: boolean,
  maxBranches: number | undefined,
  sessionId: string | undefined,
  vcs: VersionControlSystem,
  onProgress: ((step: LedgerMaterializerProgressStep) => void) | undefined,
  onProjectionPhase: ((phase: IncrementalProjectionPhase) => void) | undefined,
  onProjectionMode: ((mode: IncrementalTaskProjectionMode, reason?: IncrementalProjectionRebuildReason) => void) | undefined,
  onProjectionAttributionDecision: ((reason: AttributionProjectionDecisionReason) => void) | undefined,
  onProjectionDiagnostic: ((diagnostic: TrustedProjectionFingerprintDiagnostic | IncrementalProjectionDiagnostic) => void) | undefined
): LedgerMaterializerReport {
  const reports: LedgerMaterializerBranchReport[] = [];
  const warnings: string[] = [];
  let merged = 0;
  let processed = 0;
  let projectionSourceFingerprintBeforeMerge: string | undefined;
  const touchedPaths = new Set<string>();

  const trunkBranch = resolveTrunkBranch(repoRoot, undefined, vcs);
  if (!vcs.refExists(repoRoot, trunkBranch)) {
    return {
      dryRun,
      merged: 0,
      considered: 0,
      branches: [],
      warnings: [`trunk branch ${trunkBranch} does not exist`],
      projectionRebuilt: false,
      attributionEventsProjected: 0
    };
  }

  let branches: ReadonlyArray<string>;
  if (sessionId) {
    // A session id that yields no branch name (e.g. all-whitespace) must fail loudly:
    // filtering on undefined would silently report "no branches to materialize".
    const targetBranch = sessionBranchName(sessionId);
    if (!targetBranch) throw new Error(`invalid materializer session id: ${sessionId}`);
    branches = vcs.sessionBranches(repoRoot).filter((branch) => branch === targetBranch);
  } else {
    branches = vcs.sessionBranches(repoRoot);
  }
  for (const branch of branches) {
    const commits = vcs.commitsNotInTrunk(repoRoot, trunkBranch, branch);
    if (commits.length === 0) {
      reports.push({ branch, commitCount: 0, status: "skipped", commits });
      continue;
    }
    if (dryRun) {
      reports.push({ branch, commitCount: commits.length, status: "would_merge", commits });
      processed += 1;
      if (reachedBranchLimit(processed, maxBranches)) break;
      continue;
    }

    if (projectionSourceFingerprintBeforeMerge === undefined) {
      onProgress?.("baseline-start");
      projectionSourceFingerprintBeforeMerge = captureTrustedAuthoredProjectionFingerprint(rootInput, vcs, repoRoot, {
        onDiagnostic: onProjectionDiagnostic
      });
      onProgress?.("baseline-done");
    }

    const mergeMessage = semanticMergeMessage(commits, repoRoot, branch, vcs)
      ?? `materializer: merge session ${branch.slice("sessions/".length)}`;
    vcs.checkout(repoRoot, trunkBranch);
    // The zero-checkout publisher preserves user-authored content in the
    // worktree. git merge refuses when local changes (tracked modifications
    // or untracked files) would be overwritten by the merge. Revert only the
    // paths this merge will touch to trunk state so the merge proceeds; the
    // merge immediately restores the session's content for those paths.
    vcs.resetWorktreePaths(repoRoot, trunkBranch, vcs.changedFilesBetween(repoRoot, trunkBranch, branch));
    const beforeMergeHead = vcs.currentHead(repoRoot);
    let preservedArtifacts: ReadonlyArray<PreservedMachineArtifact> = [];
    try {
      onProgress?.("merge-start");
      vcs.mergeNoFf(repoRoot, branch, mergeMessage, materializerCommitter);
      onProgress?.("merge-done");
    } catch (error) {
      let conflictPaths: ReadonlyArray<string>;
      let recoveryError: unknown;
      try {
        const recovery = recoverScriptIngestArtifactConflicts({
          repoRoot,
          trunkBranch,
          branch,
          mergeMessage,
          vcs
        });
        conflictPaths = recovery.recovered ? [] : recovery.conflictPaths;
        if (recovery.recovered) preservedArtifacts = recovery.artifacts;
      } catch (candidateError) {
        recoveryError = candidateError;
        conflictPaths = vcs.conflictedFiles(repoRoot);
      }
      if (preservedArtifacts.length === 0) {
        const warning = `${branch}: ${error instanceof Error ? error.message : String(error)}${recoveryError ? `; machine-artifact recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` : ""}`;
        warnings.push(warning);
        try {
          vcs.abortMerge(repoRoot);
        } catch {
          // No merge was in progress or Git could not abort; keep the warning and continue.
        }
        reports.push({
          branch,
          commitCount: commits.length,
          status: "conflict",
          commits,
          warning,
          ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
          nextCommand: `git -C ${shellArgument(repoRoot)} merge --no-ff ${shellArgument(branch)}`
        });
        continue;
      }
    }
    const afterMergeHead = vcs.currentHead(repoRoot);
    for (const relativePath of vcs.changedFilesBetween(repoRoot, beforeMergeHead, afterMergeHead)) {
      touchedPaths.add(path.join(repoRoot, relativePath));
    }
    vcs.deleteBranch(repoRoot, branch);
    merged += 1;
    processed += 1;
    reports.push({
      branch,
      commitCount: commits.length,
      status: "merged",
      commits,
      ...(preservedArtifacts.length > 0 ? { preservedArtifacts } : {})
    });
    if (reachedBranchLimit(processed, maxBranches)) break;
  }

  if (merged > 0) {
    const layout = resolveHarnessLayout(rootInput);
    onProgress?.("projection-start");
    const projectionUpdate = updateTaskProjectionIncrementally({
      rootDir: layout.rootDir,
      ...(typeof rootInput === "object" && rootInput.layoutOverrides ? { layoutOverrides: rootInput.layoutOverrides } : {}),
      touchedPaths: [...touchedPaths],
      ...(projectionSourceFingerprintBeforeMerge ? { previousSourceFingerprint: projectionSourceFingerprintBeforeMerge } : {}),
      onPhase: onProjectionPhase,
      onAttributionDecision: onProjectionAttributionDecision,
      onDiagnostic: onProjectionDiagnostic
    });
    onProjectionMode?.(
      projectionUpdate.mode,
      projectionUpdate.mode === "rebuild" ? projectionUpdate.rebuildReason : undefined
    );
    if (projectionUpdate.sourceHash) {
      rememberTrustedAuthoredProjectionFingerprint(rootInput, projectionUpdate.sourceHash, vcs, repoRoot);
    } else {
      invalidateTrustedAuthoredProjectionFingerprint(rootInput, vcs, repoRoot);
    }
    onProgress?.("projection-done");
  }

  const layout = resolveHarnessLayout(rootInput);
  let attributionEventsProjected = 0;
  let projectionRebuilt = merged > 0;
  if (!dryRun) {
    if (!durableFileExists(layout.projectionPath)) {
      onProgress?.("projection-start");
      rebuildTaskProjection({
        rootDir: layout.rootDir,
        ...(typeof rootInput === "object" && rootInput.layoutOverrides ? { layoutOverrides: rootInput.layoutOverrides } : {})
      });
      projectionRebuilt = true;
      onProgress?.("projection-done");
    }
    onProgress?.("attribution-start");
    attributionEventsProjected = countAttributionProjectionRows(layout.projectionPath);
    onProgress?.("attribution-done");
  }

  return {
    dryRun,
    merged,
    considered: reports.filter((report) => report.commitCount > 0).length,
    branches: reports,
    warnings,
    projectionRebuilt,
    attributionEventsProjected
  };
}

function semanticMergeMessage(
  commits: ReadonlyArray<string>,
  repoRoot: string,
  branch: string,
  vcs: VersionControlSystem
): string | undefined {
  if (commits.length !== 1) return undefined;
  const message = vcs.commitMessage(repoRoot, branch);
  try {
    parseAuthorityBatchCommitMessage(message);
    return message;
  } catch {
    return undefined;
  }
}

function reachedBranchLimit(processed: number, maxBranches: number | undefined): boolean {
  return typeof maxBranches === "number" && Number.isFinite(maxBranches) && maxBranches > 0 && processed >= maxBranches;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}
