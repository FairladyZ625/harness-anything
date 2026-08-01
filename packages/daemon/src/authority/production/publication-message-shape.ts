import { parseAuthorityBatchCommitMessage } from "@harness-anything/kernel";
import type { FirstParentPublicationMetadata } from "./publication-history.ts";
import { publicationSubjectOperationIds } from "./publication-history.ts";

export function publicationMetadataOperationIds(
  commit: FirstParentPublicationMetadata
): ReadonlyArray<string> {
  const firstParentIds = publicationSubjectOperationIds(commit.subject);
  return firstParentIds.length > 0
    ? firstParentIds
    : publicationSubjectOperationIds(commit.sessionSubject ?? "");
}

export function publicationMessageShape(input: {
  readonly mergeSubject: string;
  readonly sessionSubject: string;
  readonly mergeMessage: string;
  readonly sessionMessage: string;
  readonly expectedOpIds: ReadonlyArray<string>;
}): {
  readonly mergeMessageMatchesSession: boolean;
  readonly legacySubjectShape: boolean;
  readonly semanticSubjectShape: boolean;
} {
  const mergeMessageMatchesSession = input.mergeMessage === input.sessionMessage;
  const legacySubjectShape = /^materializer: merge session [A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.mergeSubject)
    && input.sessionSubject.endsWith(`[${input.expectedOpIds.join(",")}]`);
  const semanticMessage = parseAuthorityBatchMessageOptional(input.mergeMessage);
  const semanticSubjectShape = !input.mergeSubject.startsWith("materializer: merge session ")
    && mergeMessageMatchesSession
    && semanticMessage !== null
    && orderedOperationIdsEqual(
      semanticMessage.integrity.entries.map((entry) => entry.opId),
      input.expectedOpIds
    );
  return { mergeMessageMatchesSession, legacySubjectShape, semanticSubjectShape };
}

export function orderedOperationIdsEqual(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

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
    `mergeTreeMatchesSession=${String(input.mergeTreeMatchesSession)}`
  ].join(";"));
}

function parseAuthorityBatchMessageOptional(
  message: string
): ReturnType<typeof parseAuthorityBatchCommitMessage> | null {
  try {
    return parseAuthorityBatchCommitMessage(message);
  } catch {
    return null;
  }
}
