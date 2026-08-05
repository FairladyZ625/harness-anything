import {
  scanAuthorityBatchCommits,
  type AuthorityBatchCommitMetadata,
  type FirstParentPublicationMetadata
} from "./publication-history.ts";

export class AuthorityCanonicalPublicationUnanchoredBatchPrefixError extends Error {
  readonly opIds: ReadonlyArray<string>;

  constructor(input: {
    readonly opIds: ReadonlyArray<string>;
    readonly commitShas?: ReadonlyArray<string>;
  }) {
    const opIds = [...new Set(input.opIds)];
    super([
      "AUTHORITY_CANONICAL_PUBLICATION_UNANCHORED_BATCH_PREFIX",
      `opIds=${opIds.join(",") || "none"}`,
      `commits=${input.commitShas?.join(",") || "unknown"}`
    ].join(";"));
    this.name = "AuthorityCanonicalPublicationUnanchoredBatchPrefixError";
    this.opIds = opIds;
  }
}

export async function assertNoUnanchoredAuthorityBatchPrefix(input: {
  readonly rootDir: string;
  readonly expectedPreviousHead: string;
  readonly publicationBase: string;
}): Promise<void> {
  if (input.expectedPreviousHead === input.publicationBase) return;
  const batches = await scanAuthorityBatchCommits({
    rootDir: input.rootDir,
    headCommit: input.publicationBase,
    exclusiveCommit: input.expectedPreviousHead
  });
  if (batches.length > 0) throw unanchoredBatchError(batches);
}

export async function unanchoredAuthorityBatchesForPublications(input: {
  readonly rootDir: string;
  readonly publications: ReadonlyArray<FirstParentPublicationMetadata>;
}): Promise<ReadonlyArray<AuthorityBatchCommitMetadata>> {
  const batches = new Map<string, AuthorityBatchCommitMetadata>();
  for (const publication of input.publications) {
    const expectedPreviousHead = publication.parents[0];
    const publicationBase = publication.sessionParents?.[0];
    if (!expectedPreviousHead || !publicationBase || expectedPreviousHead === publicationBase) continue;
    for (const batch of await scanAuthorityBatchCommits({
      rootDir: input.rootDir,
      headCommit: publicationBase,
      exclusiveCommit: expectedPreviousHead
    })) {
      batches.set(batch.commitSha, batch);
    }
  }
  return [...batches.values()];
}

export function unanchoredBatchError(
  batches: ReadonlyArray<AuthorityBatchCommitMetadata>
): AuthorityCanonicalPublicationUnanchoredBatchPrefixError {
  return new AuthorityCanonicalPublicationUnanchoredBatchPrefixError({
    opIds: batches.flatMap((batch) => batch.opIds),
    commitShas: batches.map((batch) => batch.commitSha)
  });
}
