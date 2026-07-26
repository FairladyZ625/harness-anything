import { parseAuthorityBatchCommitMessage } from "@harness-anything/kernel";
import {
  publicationSubjectOperationIds,
  type FirstParentPublicationMetadata
} from "./publication-history.ts";

export function publicationTopologyError(input: {
  readonly expectedPreviousHead: string | null;
  readonly expectedOpIds: ReadonlyArray<string>;
  readonly head: string;
  readonly parentCommits: ReadonlyArray<string>;
  readonly sessionParents: ReadonlyArray<string>;
  readonly mergeSubject: string;
  readonly sessionSubject: string;
  readonly mergeMessageMatchesSession: boolean;
  readonly legacySubjectShape: boolean;
  readonly semanticSubjectShape: boolean;
  readonly directSubjectShape: boolean;
  readonly mergeTreeMatchesSession: boolean;
}): Error {
  return new Error([
    "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR",
    `expectedPreviousHead=${input.expectedPreviousHead ?? "null"}`,
    `expectedOpIds=${input.expectedOpIds.join(",")}`,
    `head=${input.head}`,
    `actualParents=${input.parentCommits.join(",") || "none"}`,
    `actualSessionParents=${input.sessionParents.join(",") || "none"}`,
    `mergeSubject=${JSON.stringify(input.mergeSubject)}`,
    `sessionSubject=${JSON.stringify(input.sessionSubject)}`,
    `mergeMessageMatchesSession=${String(input.mergeMessageMatchesSession)}`,
    `legacySubjectShape=${String(input.legacySubjectShape)}`,
    `semanticSubjectShape=${String(input.semanticSubjectShape)}`,
    `directSubjectShape=${String(input.directSubjectShape)}`,
    `mergeTreeMatchesSession=${String(input.mergeTreeMatchesSession)}`
  ].join(";"));
}

export function publicationMetadataOperationIds(
  commit: FirstParentPublicationMetadata
): ReadonlyArray<string> {
  const authorityMessage = parseAuthorityBatchMessageOptional(commit.message);
  if (authorityMessage) {
    return authorityMessage.integrity.entries.map((entry) => entry.opId);
  }
  return commit.parents.length === 2
    ? publicationSubjectOperationIds(commit.sessionSubject ?? "")
    : [];
}

export function parseAuthorityBatchMessageOptional(
  message: string
): ReturnType<typeof parseAuthorityBatchCommitMessage> | null {
  try {
    return parseAuthorityBatchCommitMessage(message);
  } catch {
    return null;
  }
}

export function orderedValuesEqual(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}
