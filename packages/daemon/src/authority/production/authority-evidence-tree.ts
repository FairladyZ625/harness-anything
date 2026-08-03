import { readdirSync } from "node:fs";
import path from "node:path";

export interface AuthorityEvidenceWorktreeState {
  readonly pendingPaths: ReadonlyArray<string>;
  readonly historicalShardChanged: boolean;
}

export function authorityEvidenceHistoryUnchanged(
  changedPaths: ReadonlyArray<string>,
  relativeRoot: string
): boolean {
  const root = relativeRoot.replaceAll("\\", "/").replace(/\/$/u, "");
  return root.length > 0 && !changedPaths.some((candidate) => {
    const normalized = candidate.replaceAll("\\", "/");
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

interface AuthorityEvidenceCommitReader {
  readonly normalizePath: (inputPath: string) => string;
  readonly filesExistingAtCommit: (
    repoRoot: string,
    sha: string,
    input: {
      readonly relativeRoot: string;
      readonly relativePaths: ReadonlyArray<string>;
    }
  ) => ReadonlySet<string>;
}

export function readAuthorityEvidencePendingPathsAtCommit(
  evidenceRoot: string,
  repoRoot: string,
  head: string,
  vcs: AuthorityEvidenceCommitReader
): {
  readonly relativeRoot: string;
  readonly pendingPaths: ReadonlyArray<string>;
} {
  const normalizedRepoRoot = vcs.normalizePath(repoRoot);
  const relativeRoot = repoRelativePath(normalizedRepoRoot, vcs.normalizePath(evidenceRoot));
  const localPaths = readdirSync(evidenceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => repoRelativePath(
      normalizedRepoRoot,
      vcs.normalizePath(path.join(evidenceRoot, entry.name))
    ))
    .sort();
  let existingPaths: ReadonlySet<string>;
  try {
    existingPaths = vcs.filesExistingAtCommit(repoRoot, head, {
      relativeRoot,
      relativePaths: localPaths
    });
  } catch (cause) {
    throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_TREE_READ_FAILED", { cause });
  }
  return {
    relativeRoot,
    pendingPaths: localPaths.filter((relativePath) => !existingPaths.has(relativePath))
  };
}

export function readAuthorityEvidenceWorktreeState(
  relativeRoot: string,
  readGitBytes: (args: ReadonlyArray<string>) => Buffer
): AuthorityEvidenceWorktreeState {
  let statusBytes: Buffer;
  try {
    statusBytes = readGitBytes([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      `:(top,literal)${relativeRoot}`
    ]);
  } catch (cause) {
    throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_TREE_READ_FAILED", { cause });
  }
  const pendingPaths: Array<string> = [];
  let historicalShardChanged = false;
  for (const record of statusBytes.toString("utf8").split("\0").filter(Boolean)) {
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_STATUS_INVALID");
    }
    const status = record.slice(0, 2);
    const relativePath = record.slice(3);
    if (!isDirectAuthorityEvidenceShard(relativeRoot, relativePath)) continue;
    if (status === "??" || status === "A ") pendingPaths.push(relativePath);
    else historicalShardChanged = true;
  }
  return {
    pendingPaths: pendingPaths.sort(),
    historicalShardChanged
  };
}

function isDirectAuthorityEvidenceShard(relativeRoot: string, relativePath: string): boolean {
  const prefix = relativeRoot.length === 0 ? "" : `${relativeRoot}/`;
  if (!relativePath.startsWith(prefix)) return false;
  const fileName = relativePath.slice(prefix.length);
  return fileName.length > 0 && !fileName.includes("/") && fileName.endsWith(".jsonl");
}

function repoRelativePath(repoRoot: string, filePath: string): string {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error("AUTHORITY_EVENT_V2_EVIDENCE_PATH_OUTSIDE_REPOSITORY");
  }
  return relativePath.split(path.sep).join("/");
}
