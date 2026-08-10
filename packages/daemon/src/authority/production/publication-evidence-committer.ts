import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  makeLocalAuthorityAttributionEventV2Log,
  makeLocalVersionControlSystem,
  resolveHarnessLayout,
  type HarnessLayoutInput
} from "@harness-anything/kernel";
import { reportCurrentRepoWriteTelemetry } from "../../runtime/repo-write-telemetry-context.ts";
import {
  authorityEvidenceHistoryUnchanged,
  readAuthorityEvidencePendingPathsAtCommit,
  readAuthorityEvidenceWorktreeState
} from "./authority-evidence-tree.ts";
import type { GitAuthorityAttributionEvidenceCommitterV2 } from "./publication-evidence-contract.ts";

const materializerCommitter = {
  name: "Harness Anything Materializer",
  email: "materializer@harness-anything.local"
} as const;

export function createGitAuthorityAttributionEvidenceCommitterV2(
  rootInput: HarnessLayoutInput
): GitAuthorityAttributionEvidenceCommitterV2 {
  const layout = resolveHarnessLayout(rootInput);
  const vcs = makeLocalVersionControlSystem();
  const log = makeLocalAuthorityAttributionEventV2Log(rootInput);
  let verifiedHead: string | undefined;
  return {
    commitPending: async (canonicalCommitSha) => {
      const repoRoot = vcs.topLevel(layout.authoredRoot);
      if (!repoRoot) throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_REPOSITORY_REQUIRED");
      if (!vcs.commitExists(repoRoot, canonicalCommitSha)) {
        throw new Error(`AUTHORITY_EVENT_V2_EVIDENCE_CANONICAL_COMMIT_MISSING:${canonicalCommitSha}`);
      }
      const head = vcs.currentHead(repoRoot);
      reportCurrentRepoWriteTelemetry("authority-evidence-worktree");
      const { relativeRoot, pendingPaths } = readAuthorityEvidencePendingPathsAtCommit(
        layout.authorityAttributionEventsV2Root,
        repoRoot,
        head,
        vcs
      );
      const worktree = readAuthorityEvidenceWorktreeState(
        relativeRoot,
        (args) => Buffer.from(evidenceGit(repoRoot, args))
      );
      const canReuseVerifiedHistory = verifiedHead === head || verifiedHead !== undefined
        && authorityEvidenceHistoryUnchanged(vcs.changedFilesBetween(repoRoot, verifiedHead, head), relativeRoot);
      if (!canReuseVerifiedHistory) {
        reportCurrentRepoWriteTelemetry("authority-evidence-history-verify");
        log.verifyIntegrity();
        if (!worktree.historicalShardChanged) verifiedHead = head;
      } else {
        if (worktree.historicalShardChanged) {
          throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_VERIFIED_HISTORY_CHANGED");
        }
        reportCurrentRepoWriteTelemetry("authority-evidence-pending-verify");
        log.verifyShards(pendingPaths.map((relativePath) => path.basename(relativePath)));
        verifiedHead = head;
      }
      if (pendingPaths.length === 0) return;

      reportCurrentRepoWriteTelemetry("authority-evidence-git-commit");
      const pending = new Set(pendingPaths);
      assertEvidenceOnlyStaged(readNullDelimitedPaths(Buffer.from(evidenceGit(
        repoRoot,
        ["diff", "--cached", "--no-renames", "--name-only", "-z", "--"]
      ))), pending);
      commitEvidencePaths(repoRoot, head, pendingPaths, canonicalCommitSha);
      verifiedHead = vcs.currentHead(repoRoot);
      reportCurrentRepoWriteTelemetry("authority-evidence-git-commit-done");
    }
  };
}

function assertEvidenceOnlyStaged(stagedPaths: ReadonlyArray<string>, pendingPaths: ReadonlySet<string>): void {
  const unrelated = stagedPaths.filter((stagedPath) => !pendingPaths.has(stagedPath));
  if (unrelated.length > 0) {
    throw new Error(`AUTHORITY_EVENT_V2_EVIDENCE_UNRELATED_STAGED_PATHS:${unrelated.join(",")}`);
  }
}

function commitEvidencePaths(
  repoRoot: string,
  head: string,
  pendingPaths: ReadonlyArray<string>,
  canonicalCommitSha: string
): void {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "ha-authority-evidence-index-"));
  const indexPath = path.join(temporaryDirectory, "index");
  const environment = { GIT_INDEX_FILE: indexPath };
  try {
    evidenceGit(repoRoot, ["read-tree", head], undefined, environment);
    const objectIds = evidenceGit(
      repoRoot,
      ["hash-object", "-w", "--stdin-paths"],
      `${pendingPaths.join("\n")}\n`
    ).trim().split("\n");
    if (objectIds.length !== pendingPaths.length || objectIds.some((objectId) => !/^[a-f0-9]{40,64}$/u.test(objectId))) {
      throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_OBJECT_BATCH_INVALID");
    }
    const indexInfo = Buffer.concat(pendingPaths.map((relativePath, index) =>
      Buffer.from(`100644 ${objectIds[index]!}\t${relativePath}\0`, "utf8")));
    evidenceGit(repoRoot, ["update-index", "-z", "--index-info"], indexInfo, environment);
    const tree = evidenceGit(repoRoot, ["write-tree"], undefined, environment).trim();
    const commit = evidenceGit(repoRoot, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      `authority: V2 attribution evidence for ${canonicalCommitSha.slice(0, 12)}`
    ], undefined, {}, materializerCommitter).trim();
    evidenceGit(repoRoot, ["update-index", "-z", "--index-info"], indexInfo);
    evidenceGit(repoRoot, ["update-ref", "HEAD", commit, head]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function evidenceGit(
  repoRoot: string,
  args: ReadonlyArray<string>,
  input?: string | Buffer,
  environment: Readonly<Record<string, string>> = {},
  author?: typeof materializerCommitter
): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...environment,
      ...(author
        ? {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email
          }
        : {})
    }
  });
}

function readNullDelimitedPaths(bytes: Uint8Array): ReadonlyArray<string> {
  return Buffer.from(bytes).toString("utf8").split("\0").filter(Boolean);
}
