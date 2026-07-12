import type { VersionControlSystem } from "../ports/version-control-system.ts";

type CodeDocGitEvidenceVersionControlSystem = Pick<
  VersionControlSystem,
  "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit"
>;

export interface CodeDocGitEvidence {
  readonly sha: string;
  readonly path?: string;
}

export type CodeDocGitEvidenceResolution =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly reason: "commit-missing" | "path-missing" };

export interface CodeDocGitEvidenceResolver {
  readonly candidateRoots: ReadonlyArray<string>;
  readonly resolve: (evidence: CodeDocGitEvidence) => CodeDocGitEvidenceResolution;
}

export function makeCodeDocGitEvidenceResolver(
  input: { readonly rootDir: string; readonly authoredRoot: string },
  versionControlSystem: CodeDocGitEvidenceVersionControlSystem
): CodeDocGitEvidenceResolver {
  const candidateRoots = uniqueRepoRoots([
    versionControlSystem.topLevel(input.rootDir),
    versionControlSystem.topLevel(input.authoredRoot)
  ], versionControlSystem);

  return {
    candidateRoots,
    resolve: (evidence) => {
      const commitRoots = candidateRoots.filter((repoRoot) =>
        versionControlSystem.commitExists(repoRoot, evidence.sha)
      );
      if (commitRoots.length === 0) return { ok: false, reason: "commit-missing" };
      if (evidence.path === undefined) return { ok: true, repoRoot: commitRoots[0]! };
      const pathRoot = commitRoots.find((repoRoot) =>
        versionControlSystem.pathExistsAtCommit(repoRoot, evidence.sha, evidence.path!)
      );
      return pathRoot
        ? { ok: true, repoRoot: pathRoot }
        : { ok: false, reason: "path-missing" };
    }
  };
}

function uniqueRepoRoots(
  roots: ReadonlyArray<string | null>,
  versionControlSystem: Pick<VersionControlSystem, "normalizePath">
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    if (root === null) continue;
    const normalized = versionControlSystem.normalizePath(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(root);
  }
  return unique;
}
