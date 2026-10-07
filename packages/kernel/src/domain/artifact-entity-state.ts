import { isEntityDeclarationEvent, ownedContentForDeclarationEvent, type StoredEntityEventV1 } from "./entity-event.ts";
import type { EntityOwnedContentV1 } from "./entity-owned-content.ts";

/** Accepted artifact state, including the version a deletion leaves behind. */
export interface ArtifactEntityState {
  readonly revision: number;
  readonly declarationClaimSha: string | null;
  readonly ownedContent: EntityOwnedContentV1 | null;
}

/** One reducer for command folding and the disposable center/edge query projection. */
export function reduceArtifactEntityState(
  before: ArtifactEntityState | null,
  event: StoredEntityEventV1,
): ArtifactEntityState {
  const revision = Math.max(before?.revision ?? 0, event.workspaceRevision);
  if (event.type === "entity_deleted") return { revision, declarationClaimSha: null, ownedContent: null };
  if (isEntityDeclarationEvent(event) && (event.type === "entity_content_observed" || event.type === "entity_updated"))
    return {
      revision,
      declarationClaimSha: event.payload.declarationDocumentClaim.sha256,
      ownedContent: ownedContentForDeclarationEvent(event),
    };
  return {
    revision,
    declarationClaimSha: before?.declarationClaimSha ?? null,
    ownedContent: before?.ownedContent ?? null,
  };
}
