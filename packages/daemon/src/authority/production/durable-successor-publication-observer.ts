import type {
  CanonicalPublicationEvidence,
  GitCanonicalPublicationInspector
} from "./publication-evidence.ts";

export function createDurableSuccessorPublicationObserver(
  inspector: GitCanonicalPublicationInspector
): (
  previousCommit: string | null,
  expectedOpIds: ReadonlyArray<string>,
  expectedCommitSha?: string
) => Promise<CanonicalPublicationEvidence> {
  return async (previousCommit, expectedOpIds, expectedCommitSha) => {
    if (expectedCommitSha && expectedOpIds.length > 1) {
      const successor = await inspector.findDurableSuccessorPublicationForOperation(
        expectedOpIds[0]!,
        expectedCommitSha
      );
      if (successor.opIds.length !== expectedOpIds.length
        || successor.opIds.some((opId, index) => expectedOpIds[index] !== opId)) {
        throw new Error("AUTHORITY_PRODUCTION_PUBLICATION_OPERATION_GROUP_MISMATCH");
      }
      return successor;
    }
    return inspector.inspectPublication(previousCommit, expectedOpIds, expectedCommitSha);
  };
}
