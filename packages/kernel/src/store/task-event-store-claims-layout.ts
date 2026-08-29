import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { isEntityEvent } from "../domain/entity-event.ts";
import { isScheduleEvent } from "../domain/schedule-event.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
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
import { type LedgerLayoutMigrationEventV1 } from "../domain/ledger-layout-migration-event.ts";
import { isTaskBootstrapEvent, taskBootstrapClaims } from "../domain/task-bootstrap-event.ts";
import { isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { isSnapshotUpgradeEvent, snapshotUpgradeClaims } from "../domain/task-snapshot-upgrade-store-seam.ts";
import { type WriteTarget } from "../domain/write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { ledgerGitPath, type LedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore as gitObjects, localGitText } from "./local-version-control-system.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import {
  batchTree,
  eventEntriesFromShards,
  type GitTreeEntry,
  scanEventsRoot,
  treeObjectAt,
} from "./task-event-store-layout.ts";

// Canonical document claim extraction plus flat-to-sharded layout auditing.
export function canonicalDocumentClaims(event: PersistedCanonicalEventV1): readonly {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  if (isEntityEvent(event)) return [event.payload.declarationDocumentClaim];
  if (isScheduleEvent(event))
    return "declarationDocumentClaim" in event.payload ? [event.payload.declarationDocumentClaim] : [];
  if (isSettingsEvent(event)) return [event.payload.harnessDocumentClaim];
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
  if (isEntityEvent(event)) return [];
  if (isScheduleEvent(event) && "declarationDocumentRetirement" in event.payload)
    return [event.payload.declarationDocumentRetirement];
  return isDocEvent(event)
    ? event.payload.changes.flatMap(({ path: target, baseBlobSha256, candidate }) =>
        candidate === null && baseBlobSha256 !== null ? [{ path: target, baseBlobSha256 }] : [],
      )
    : [];
}
export function contentClaims(event: CanonicalEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  if (isScheduleEvent(event))
    return "declarationDocumentClaim" in event.payload ? [event.payload.declarationDocumentClaim] : [];
  if (isSettingsEvent(event)) return [event.payload.harnessDocumentClaim];
  if (isPeopleEvent(event)) return [event.payload.peopleDocumentClaim];
  const claims = isDocEvent(event)
    ? event.payload.changes.flatMap((change) => (change.candidate === null ? [] : [change.candidate]))
    : isEntityEvent(event)
      ? [event.payload.declarationDocumentClaim]
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
export function flatLayoutAt(
  ledger: LedgerGitLayout,
  commit: string,
): {
  readonly events: readonly GitTreeEntry[];
  readonly blobs: readonly GitTreeEntry[];
  readonly preEventsTreeSha: string;
  readonly hasShardedEvents: boolean;
  readonly hasShardedBlobs: boolean;
} {
  const eventsTree = treeObjectAt(ledger.rootDir, `${commit}:${ledgerGitPath(ledger, "events")}`);
  if (!eventsTree) throw new TaskEventStoreError("invalid_store", "flat ledger has no events tree");
  const events = eventsTree.entries.filter(
    ({ mode, name }) => mode === "100644" && name !== "head.json" && name.endsWith(".json"),
  );
  const hasShardedEvents = eventsTree.entries.some(({ mode, name }) => mode === "40000" && /^[0-9a-f]{2}$/u.test(name));
  for (const entry of eventsTree.entries)
    if (
      entry.name !== "head.json" &&
      !events.includes(entry) &&
      !(entry.mode === "40000" && /^[0-9a-f]{2}$/u.test(entry.name))
    )
      throw new TaskEventStoreError("invalid_store", `events root contains invalid migration source ${entry.name}`);
  const blobsTree = treeObjectAt(ledger.rootDir, `${commit}:${ledgerGitPath(ledger, "objects/sha256")}`);
  const blobs = blobsTree?.entries.filter(({ mode, name }) => mode === "100644" && /^[0-9a-f]{64}$/u.test(name)) ?? [];
  const hasShardedBlobs =
    blobsTree?.entries.some(({ mode, name }) => mode === "40000" && /^[0-9a-f]{2}$/u.test(name)) ?? false;
  for (const entry of blobsTree?.entries ?? [])
    if (!blobs.includes(entry) && !(entry.mode === "40000" && /^[0-9a-f]{2}$/u.test(entry.name)))
      throw new TaskEventStoreError(
        "invalid_store",
        `content object root contains invalid migration source ${entry.name}`,
      );
  return {
    events,
    blobs,
    preEventsTreeSha: eventsTree.oid,
    hasShardedEvents,
    hasShardedBlobs,
  };
}
export function auditLayoutMigration(
  ledger: LedgerGitLayout,
  parent: string,
  commit: string,
  event: LedgerLayoutMigrationEventV1,
): void {
  const before = flatLayoutAt(ledger, parent);
  if (
    before.preEventsTreeSha !== event.payload.preEventsTreeSha ||
    before.events.length !== event.payload.eventCount ||
    before.blobs.length !== event.payload.blobCount
  )
    throw new TaskEventStoreError("invalid_store", "migration event does not describe its parent layout");
  const beforeCommitCount = Number(localGitText(ledger.rootDir, "rev-list", "--count", parent).trim());
  const afterCommitCount = Number(localGitText(ledger.rootDir, "rev-list", "--count", commit).trim());
  if (afterCommitCount !== beforeCommitCount + 1)
    throw new TaskEventStoreError("invalid_store", "migration must add exactly one canonical commit");
  if (!gitObjects.isAncestor(ledger.rootDir, parent, commit))
    throw new TaskEventStoreError("invalid_store", "pre-migration head is not an ancestor of the migrated head");
  const beforeObjects = reachableObjects(ledger.rootDir, parent);
  const afterObjects = reachableObjects(ledger.rootDir, commit);
  if ([...beforeObjects].some((oid) => !afterObjects.has(oid)))
    throw new TaskEventStoreError("invalid_store", "migration lost an object reachable from its parent");
  const eventEntries = eventEntriesFromShards(ledger, scanEventsRoot(ledger, commit)?.shards ?? []);
  if (eventEntries.length !== event.payload.eventCount + 1)
    throw new TaskEventStoreError("invalid_store", "migrated event count does not match the migration event");
  const eventsRoot = treeObjectAt(ledger.rootDir, `${commit}:${ledgerGitPath(ledger, "events")}`);
  if (!eventsRoot || eventsRoot.entries.some(({ name }) => name.endsWith(".json") && name !== "head.json"))
    throw new TaskEventStoreError("invalid_store", "migrated events root still contains direct event JSON");
  if (countShardedBlobs(ledger, commit) !== event.payload.blobCount)
    throw new TaskEventStoreError("invalid_store", "migrated blob count does not match the migration event");
}
export function countShardedBlobs(ledger: LedgerGitLayout, commit: string): number {
  const root = treeObjectAt(ledger.rootDir, `${commit}:${ledgerGitPath(ledger, "objects/sha256")}`);
  if (!root) return 0;
  const shards = root.entries.filter(({ mode, name }) => mode === "40000" && /^[0-9a-f]{2}$/u.test(name));
  if (shards.length !== root.entries.length)
    throw new TaskEventStoreError("invalid_store", "migrated content object root contains a flat entry");
  if (shards.length === 0) return 0;
  const output = gitObjects.batch(ledger.rootDir, `${shards.map(({ oid }) => oid).join("\n")}\n`);
  let count = 0;
  let cursor = 0;
  for (const shard of shards) {
    const parsed = batchTree(output, cursor);
    for (const entry of parsed.entries)
      if (entry.mode !== "100644" || !/^[0-9a-f]{62}$/u.test(entry.name))
        throw new TaskEventStoreError(
          "invalid_store",
          `content object shard ${shard.name} contains invalid entry ${entry.name}`,
        );
    count += parsed.entries.length;
    cursor = parsed.next;
  }
  return count;
}
export function reachableObjects(repoRoot: string, commit: string): ReadonlySet<string> {
  return new Set(
    localGitText(repoRoot, "rev-list", "--objects", "--no-object-names", commit).trim().split(/\r?\n/u).filter(Boolean),
  );
}
export function commitParent(repoRoot: string, commit: string): string {
  const parent = localGitText(repoRoot, "rev-parse", `${commit}^`).trim();
  if (!/^[0-9a-f]{40}$/u.test(parent)) throw new TaskEventStoreError("invalid_store", "prepared commit has no parent");
  return parent;
}
export function stripLedgerPrefix(ledger: LedgerGitLayout, target: string): string {
  const prefix = ledger.authoredPrefix ? `${ledger.authoredPrefix}/` : "";
  if (prefix && !target.startsWith(prefix))
    throw new TaskEventStoreError("invalid_store", `prepared path is outside the ledger: ${target}`);
  return prefix ? target.slice(prefix.length) : target;
}
