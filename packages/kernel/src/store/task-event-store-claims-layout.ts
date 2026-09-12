import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { isEntityDeclarationEvent, isEntityEvent, ownedContentForDeclarationEvent } from "../domain/entity-event.ts";
import {
  entityOwnedContentClaims,
  entityOwnedDirectories,
  entityOwnedDocumentClaims,
  entityRetiredDirectories,
} from "../domain/entity-owned-content.ts";
import { isScheduleEvent } from "../domain/schedule-event.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { isVerticalDeclarationEvent } from "../domain/vertical-declaration.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import {
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  type CanonicalEventV1,
  type PersistedCanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { migrationImportClaims, migrationImportContentClaims } from "../domain/migration-import-event.ts";
import { isTaskBootstrapEvent, taskBootstrapClaims } from "../domain/task-bootstrap-event.ts";
import { isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { isSnapshotUpgradeEvent, snapshotUpgradeClaims } from "../domain/task-snapshot-upgrade-store-seam.ts";

// Canonical document claim extraction plus flat-to-sharded layout auditing.
export function canonicalDocumentClaims(event: PersistedCanonicalEventV1): readonly {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  if (isEntityEvent(event))
    return isEntityDeclarationEvent(event) ? entityOwnedDocumentClaims(ownedContentForDeclarationEvent(event)) : [];
  if (isScheduleEvent(event))
    return "declarationDocumentClaim" in event.payload ? [event.payload.declarationDocumentClaim] : [];
  if (isSettingsEvent(event)) return [event.payload.harnessDocumentClaim];
  if (isVerticalDeclarationEvent(event)) return [event.payload.declarationDocumentClaim];
  if (isPeopleEvent(event)) return [event.payload.peopleDocumentClaim];
  return isDocEvent(event)
    ? event.payload.changes.flatMap(({ path: target, candidate }) =>
        candidate === null ? [] : [{ path: target, ...candidate }],
      )
    : isTaskEvent(event)
      ? [
          ...(event.payload.documentClaims ?? []),
          ...(event.payload.carriedDocumentClaims ?? []).map(({ path: target, candidate }) => ({
            path: target,
            ...candidate,
          })),
        ]
      : isTaskBootstrapEvent(event)
        ? event.payload.initialDocumentClaims
        : isSnapshotUpgradeEvent(event)
          ? [event.payload.taskContractClaim]
          : isTaskProgressEvent(event)
            ? [
                event.payload.resultDocumentClaim,
                ...(event.payload.carriedDocumentClaims ?? []).map(({ path: target, candidate }) => ({
                  path: target,
                  ...candidate,
                })),
              ]
            : isFactEvent(event)
              ? [event.payload.factsDocumentClaim]
              : isDecisionEvent(event)
                ? [event.payload.decisionDocumentClaim]
                : isMigrationImportEvent(event)
                  ? migrationImportClaims(event)
                  : [];
}
export function canonicalDocumentRetirements(
  event: PersistedCanonicalEventV1,
): readonly { readonly path: string; readonly baseBlobSha256: string }[] {
  // An update that drops a file the entity used to own retires that path, exactly like a delete does; folding
  // only `entity_deleted` here would leave the dropped file standing in the worktree with no event owning it.
  if (isEntityEvent(event))
    return event.type === "entity_deleted"
      ? event.payload.ownedContent.retirements
      : isEntityDeclarationEvent(event)
        ? ownedContentForDeclarationEvent(event).retirements
        : [];
  if (isScheduleEvent(event) && "declarationDocumentRetirement" in event.payload)
    return [event.payload.declarationDocumentRetirement];
  return isDocEvent(event)
    ? event.payload.changes.flatMap(({ path: target, baseBlobSha256, candidate }) =>
        candidate === null && baseBlobSha256 !== null ? [{ path: target, baseBlobSha256 }] : [],
      )
    : [];
}
/**
 * The directories one event says its owner holds, and the ones it says the owner has stopped holding. Git cannot
 * store an empty tree, so the manifest is the only durable record: materialization creates a held directory from
 * it, and retires a released one from it. Both sides are read off the event and nothing else — a directory that
 * is merely sitting empty on disk was never claimed by this owner and is not in either list, which is what keeps
 * a directory the user made inside an entity's content root from being taken away with the entity.
 */
export function canonicalOwnedDirectories(event: PersistedCanonicalEventV1): {
  readonly ownerRef: string;
  /** Directories the manifest states explicitly, because no file of theirs implies them. */
  readonly directories: readonly string[];
  /** Directories this owner held under an earlier accepted manifest and holds no longer. */
  readonly retirements: readonly string[];
} | null {
  if (!isEntityEvent(event)) return null;
  if (event.type === "entity_deleted")
    return {
      ownerRef: event.payload.ownedContent.ownerRef,
      directories: [],
      retirements: entityRetiredDirectories(event.payload.ownedContent),
    };
  if (!isEntityDeclarationEvent(event)) return null;
  const manifest = ownedContentForDeclarationEvent(event);
  return {
    ownerRef: manifest.ownerRef,
    directories: entityOwnedDirectories(manifest),
    retirements: entityRetiredDirectories(manifest),
  };
}

export function canonicalDocumentMode(event: CanonicalEventV1, documentPath: string): "100644" | "120000" {
  return isMigrationImportEvent(event) &&
    event.payload.entity.kind === "repo-document" &&
    event.payload.entity.nodeKind === "symbolic-link" &&
    event.payload.entity.documentClaim.path === documentPath
    ? "120000"
    : "100644";
}
export function contentClaims(event: CanonicalEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  if (isScheduleEvent(event))
    return "declarationDocumentClaim" in event.payload ? [event.payload.declarationDocumentClaim] : [];
  if (isSettingsEvent(event)) return [event.payload.harnessDocumentClaim];
  if (isVerticalDeclarationEvent(event)) return [event.payload.declarationDocumentClaim];
  if (isPeopleEvent(event)) return [event.payload.peopleDocumentClaim];
  const claims = isDocEvent(event)
    ? event.payload.changes.flatMap((change) => (change.candidate === null ? [] : [change.candidate]))
    : isEntityEvent(event)
      ? isEntityDeclarationEvent(event)
        ? entityOwnedContentClaims(ownedContentForDeclarationEvent(event))
        : []
      : isTaskEvent(event)
        ? [
            ...(event.payload.documentClaims ?? []),
            ...(event.payload.carriedDocumentClaims ?? []).map((change) => change.candidate),
          ]
        : isTaskBootstrapEvent(event)
          ? taskBootstrapClaims(event)
          : isSnapshotUpgradeEvent(event)
            ? snapshotUpgradeClaims(event)
            : isTaskProgressEvent(event)
              ? [
                  event.payload.resultDocumentClaim,
                  ...(event.payload.carriedDocumentClaims ?? []).map((change) => change.candidate),
                ]
              : isFactEvent(event)
                ? [event.payload.factsDocumentClaim]
                : isDecisionEvent(event)
                  ? [event.payload.decisionDocumentClaim]
                  : isMigrationImportEvent(event)
                    ? migrationImportContentClaims(event)
                    : isAgentRuntimeEvent(event)
                      ? runtimeEventContentClaims(event)
                      : [];
  return [...new Map(claims.map((claim) => [claim.sha256, claim])).values()];
}
