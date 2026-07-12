import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import { updateTaskProjectionIncrementally } from "../projection/sqlite-task-incremental-projection.ts";
import { readMarkdownSource } from "../projection/sqlite-task-source.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
import { resolveTrunkBranch } from "./write-journal-git.ts";
import { withRepoLocks } from "./write-journal-locks.ts";
import type { OwnedLock } from "./write-journal-types.ts";

export interface LedgerMaterializerBranchReport {
  readonly branch: string;
  readonly commitCount: number;
  readonly status: "merged" | "would_merge" | "skipped" | "conflict";
  readonly commits: ReadonlyArray<string>;
  readonly warning?: string;
}

export interface LedgerMaterializerReport {
  readonly dryRun: boolean;
  readonly merged: number;
  readonly considered: number;
  readonly branches: ReadonlyArray<LedgerMaterializerBranchReport>;
  readonly warnings: ReadonlyArray<string>;
  readonly projectionRebuilt: boolean;
}

export interface LedgerMaterializerOptions {
  readonly dryRun?: boolean;
  readonly maxBranches?: number;
  readonly heldGlobalLock?: OwnedLock;
  readonly versionControlSystem?: VersionControlSystem;
}

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
      projectionRebuilt: false
    };
  }

  return withRepoLocks(layout.rootDir, rootInput, layout.journalPath, { scope: "operational", kind: "system", id: "ledger-materializer" }, 60_000, [], () => {
    return materializeBranches(repoRoot, rootInput, options.dryRun === true, options.maxBranches, versionControlSystem);
  }, { heldGlobalLock: options.heldGlobalLock });
}

function materializeBranches(repoRoot: string, rootInput: HarnessLayoutInput, dryRun: boolean, maxBranches: number | undefined, vcs: VersionControlSystem): LedgerMaterializerReport {
  const reports: LedgerMaterializerBranchReport[] = [];
  const warnings: string[] = [];
  let merged = 0;
  let processed = 0;
  const projectionSourceHashBeforeMerge = readMarkdownSource(rootInput).hash;
  const touchedPaths = new Set<string>();

  const trunkBranch = resolveTrunkBranch(repoRoot, undefined, vcs);
  if (!vcs.refExists(repoRoot, trunkBranch)) {
    return {
      dryRun,
      merged: 0,
      considered: 0,
      branches: [],
      warnings: [`trunk branch ${trunkBranch} does not exist`],
      projectionRebuilt: false
    };
  }

  const branches = vcs.sessionBranches(repoRoot);
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

    vcs.checkout(repoRoot, trunkBranch);
    try {
      const beforeMergeHead = vcs.currentHead(repoRoot);
      vcs.mergeNoFf(repoRoot, branch, `materializer: merge session ${branch.slice("sessions/".length)}`);
      const afterMergeHead = vcs.currentHead(repoRoot);
      for (const relativePath of vcs.changedFilesBetween(repoRoot, beforeMergeHead, afterMergeHead)) {
        touchedPaths.add(path.join(repoRoot, relativePath));
      }
      vcs.deleteBranch(repoRoot, branch);
      merged += 1;
      reports.push({ branch, commitCount: commits.length, status: "merged", commits });
    } catch (error) {
      const warning = `${branch}: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(warning);
      try {
        vcs.abortMerge(repoRoot);
      } catch {
        // No merge was in progress or Git could not abort; keep the warning and continue.
      }
      reports.push({ branch, commitCount: commits.length, status: "conflict", commits, warning });
    }
    processed += 1;
    if (reachedBranchLimit(processed, maxBranches)) break;
  }

  if (merged > 0) {
    const layout = resolveHarnessLayout(rootInput);
    updateTaskProjectionIncrementally({
      rootDir: layout.rootDir,
      ...(typeof rootInput === "object" && rootInput.layoutOverrides ? { layoutOverrides: rootInput.layoutOverrides } : {}),
      touchedPaths: [...touchedPaths],
      previousSourceHash: projectionSourceHashBeforeMerge
    });
  }

  return {
    dryRun,
    merged,
    considered: reports.filter((report) => report.commitCount > 0).length,
    branches: reports,
    warnings,
    projectionRebuilt: merged > 0
  };
}

function reachedBranchLimit(processed: number, maxBranches: number | undefined): boolean {
  return typeof maxBranches === "number" && Number.isFinite(maxBranches) && maxBranches > 0 && processed >= maxBranches;
}
