interface AuthorityEvidenceCommitQueue {
  readonly enqueueBackgroundBatch?: <Result>(request: {
    readonly source: string;
    readonly priority: "normal";
    readonly run: () => Result | Promise<Result>;
  }) => Promise<Result>;
}

export async function commitAuthorityEvidence(
  queue: AuthorityEvidenceCommitQueue,
  commit: () => Promise<void>
): Promise<void> {
  if (!queue.enqueueBackgroundBatch) return commit();
  await queue.enqueueBackgroundBatch({
    source: "authority-evidence-commit",
    priority: "normal",
    run: commit
  });
}
