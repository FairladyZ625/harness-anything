import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { isEntityDeclarationEvent, isEntityEvent, ownedContentForDeclarationEvent } from "../domain/entity-event.ts";
import {
  entityOwnedContentClaims,
  entityOwnedDirectories,
  entityOwnedDocumentClaims,
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
import { type WriteTarget } from "../domain/write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";

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
 * The empty directories one event says its owner holds. Git cannot store an empty tree, so the manifest is the
 * only durable record and materialization recreates the directory from it; an event that owns none states none,
 * which is how a delete stops an owner's directories from being recreated on the next rebuild.
 */
export function canonicalOwnedDirectories(event: PersistedCanonicalEventV1): {
  readonly ownerRef: string;
  /** The entity's own content root: the only subtree its directories may ever be retired from. */
  readonly contentRoot: string;
  /** Directories the manifest states explicitly, because no file of theirs implies them. */
  readonly directories: readonly string[];
  /** Every directory under the content root that this event still needs to exist. */
  readonly footprint: readonly string[];
} | null {
  if (!isEntityEvent(event)) return null;
  if (event.type === "entity_deleted") {
    const root = deletedContentRoot(event.payload.ownedContent.retirements.map(({ path }) => path));
    // A delete states no directory at all, which is exactly what makes every directory under its root retirable.
    return root === null
      ? null
      : { ownerRef: event.payload.ownedContent.ownerRef, contentRoot: root, directories: [], footprint: [] };
  }
  if (!isEntityDeclarationEvent(event)) return null;
  const manifest = ownedContentForDeclarationEvent(event),
    directories = entityOwnedDirectories(manifest),
    contentRoot = entityContentRootOfClaim(event.payload.declarationDocumentClaim.path);
  return {
    ownerRef: manifest.ownerRef,
    contentRoot,
    directories,
    footprint: ownedDirectoryFootprint(
      contentRoot,
      directories,
      manifest.bindings.map(({ path }) => path),
    ),
  };
}

/** The entity's own content root, read off the declaration document the same way the registry derives it. */
function entityContentRootOfClaim(documentPath: string): string {
  const basename = documentPath.slice(documentPath.lastIndexOf("/") + 1);
  return basename.lastIndexOf(".") <= 0 ? documentPath : documentPath.slice(0, documentPath.lastIndexOf("."));
}

/**
 * A delete retires the declaration document and everything the entity had under that document's root, so the
 * one retirement whose root contains all the others is the declaration, and its root is the entity's.
 */
function deletedContentRoot(retirements: readonly string[]): string | null {
  for (const candidate of retirements) {
    const root = entityContentRootOfClaim(candidate);
    if (root !== candidate && retirements.every((other) => other === candidate || other.startsWith(`${root}/`)))
      return root;
  }
  return null;
}

/**
 * The directories an entity materializes: its content root, every declared empty directory, and every directory
 * that holds one of its bound files. Nothing above the content root is included — those are shared with other
 * entities and are not this entity's to retire.
 */
function ownedDirectoryFootprint(
  root: string,
  directories: readonly string[],
  files: readonly string[],
): readonly string[] {
  const held = new Set<string>([root]),
    prefix = `${root}/`,
    hold = (candidate: string) => {
      for (let held_at = candidate; held_at.startsWith(prefix); held_at = held_at.slice(0, held_at.lastIndexOf("/")))
        held.add(held_at);
    };
  for (const directory of directories) hold(directory);
  for (const file of files) if (file.startsWith(prefix)) hold(file.slice(0, file.lastIndexOf("/")));
  return [...held];
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
export function targetShape(targets: readonly WriteTarget[]): string {
  return stableStringify(targets.map(stableStringify).sort());
}
