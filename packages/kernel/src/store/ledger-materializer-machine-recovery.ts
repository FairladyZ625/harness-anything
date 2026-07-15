import { createHash } from "node:crypto";
import type { VersionControlSystem } from "../ports/version-control-system.ts";

export interface PreservedMachineArtifact {
  readonly originalPath: string;
  readonly preservedPath: string;
  readonly sourceBranch: string;
  readonly sha256: string;
}

export type MachineArtifactRecoveryResult =
  | { readonly recovered: true; readonly artifacts: ReadonlyArray<PreservedMachineArtifact> }
  | { readonly recovered: false; readonly conflictPaths: ReadonlyArray<string> };

const materializerCommitter = {
  name: "Harness Anything Materializer",
  email: "materializer@harness-anything.local"
} as const;

export function recoverScriptIngestArtifactConflicts(input: {
  readonly repoRoot: string;
  readonly trunkBranch: string;
  readonly branch: string;
  readonly mergeMessage: string;
  readonly vcs: VersionControlSystem;
}): MachineArtifactRecoveryResult {
  const conflictPaths = input.vcs.conflictedFiles(input.repoRoot);
  if (conflictPaths.length === 0) return { recovered: false, conflictPaths };

  const archiveRoot = recoveryArchiveRoot(input.branch, conflictPaths);
  if (!archiveRoot || input.vcs.worktreePathExists(input.repoRoot, archiveRoot)) {
    return { recovered: false, conflictPaths };
  }

  const candidates = conflictPaths.flatMap((originalPath) => {
    const artifactPath = taskArtifactPath(originalPath);
    if (!artifactPath) return [];
    const subject = input.vcs.latestCommitSubjectForPath(
      input.repoRoot,
      input.trunkBranch,
      input.branch,
      originalPath
    );
    if (!subject?.startsWith("entity(script-ingest):")) return [];
    const body = input.vcs.readConflictStage(input.repoRoot, 3, originalPath);
    if (body === null) return [];
    const preservedPath = `${archiveRoot}/incoming/${artifactPath.relativeArtifactPath}`;
    return [{
      body,
      originalPath,
      preservedPath,
      sourceBranch: input.branch,
      sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`
    }];
  });
  if (candidates.length !== conflictPaths.length) return { recovered: false, conflictPaths };

  const manifestPath = `${archiveRoot}/recovery.json`;
  try {
    input.vcs.checkoutConflictSide(input.repoRoot, "ours", conflictPaths);
    for (const candidate of candidates) {
      input.vcs.writeWorktreeFile(input.repoRoot, candidate.preservedPath, candidate.body);
    }
    const manifest = {
      schema: "materializer-machine-recovery/v1",
      sourceBranch: input.branch,
      strategy: "canonical-retained-incoming-preserved",
      artifacts: candidates.map(({ body: _body, ...candidate }) => candidate)
    };
    input.vcs.writeWorktreeFile(
      input.repoRoot,
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    input.vcs.add(input.repoRoot, { paths: [...conflictPaths, archiveRoot] });
    input.vcs.commit(input.repoRoot, input.mergeMessage, materializerCommitter);
  } catch (error) {
    input.vcs.removeWorktreePath(input.repoRoot, archiveRoot);
    throw error;
  }

  return {
    recovered: true,
    artifacts: candidates.map(({ body: _body, ...candidate }) => candidate)
  };
}

function recoveryArchiveRoot(branch: string, conflictPaths: ReadonlyArray<string>): string | null {
  const first = taskArtifactPath(conflictPaths[0] ?? "");
  if (!first) return null;
  if (!conflictPaths.every((candidate) => taskArtifactPath(candidate)?.artifactsRoot === first.artifactsRoot)) {
    return null;
  }
  const sessionId = branch.startsWith("sessions/") ? branch.slice("sessions/".length) : branch;
  const readableId = sessionId.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80) || "session";
  const branchHash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return `${first.artifactsRoot}/orchestration/materializer-recovery/${readableId}-${branchHash}`;
}

function taskArtifactPath(value: string): {
  readonly artifactsRoot: string;
  readonly relativeArtifactPath: string;
} | null {
  const match = /^(tasks\/[^/]+\/artifacts)\/(.+)$/u.exec(value);
  if (!match?.[1] || !match[2] || match[2].split("/").some((segment) => segment === ".." || segment.length === 0)) {
    return null;
  }
  return { artifactsRoot: match[1], relativeArtifactPath: match[2] };
}
