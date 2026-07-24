export interface AuthorityEvidenceWorktreeState {
  readonly pendingPaths: ReadonlyArray<string>;
  readonly historicalShardChanged: boolean;
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
