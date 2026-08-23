import { createHash } from "node:crypto";
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { assertAgentEntityWritePlan, isAgentEntityEvent } from "../domain/agent-entity-event.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  ledgerCommitSha,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  validateCurrentCanonicalEvent,
  validateCurrentDocEvent,
  type CanonicalEventV1,
  type DocEventV1,
  type LedgerCommitSha,
} from "../domain/doc-sync.contract.ts";
import {
  assertMigrationImportWritePlan,
  migrationImportClaims,
  migrationImportContentClaims,
} from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
  ledgerLayoutMigrationWritePlan,
  type LedgerLayoutMigrationEventV1,
} from "../domain/ledger-layout-migration-event.ts";
import { assertDecisionWritePlan } from "../domain/decision-event.ts";
import { assertFactWritePlan } from "../domain/fact-event.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  taskBootstrapClaims,
  type TaskBootstrapEventV1,
} from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import {
  assertSnapshotUpgradeInputs,
  isSnapshotUpgradeEvent,
  snapshotUpgradeClaims,
} from "../domain/task-snapshot-upgrade-store-seam.ts";
import {
  freezeDeclaredWritePlan,
  isFrozenWritePlan,
  serializeEventHead,
  type ActorIdentity,
  type EventHead,
  type FrozenWritePlan,
  type LedgerCutIdentity,
  type WriteSource,
  type WriteTarget,
} from "../domain/write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import {
  assertPublishableOpId,
  contentObjectRelativePath,
  eventObjectRelativePath,
  eventObjectShard,
  eventObjectTarget,
  type LedgerLayoutState,
  type LedgerObjectLayout,
} from "../layout/ledger-object-layout.ts";
import { ledgerGitPath, resolveLedgerGitLayout, type LedgerGitLayout } from "./ledger-git-layout.ts";
import {
  localGitObjectRefStore as gitObjects,
  localGitText,
  localGitWorktreeSettlement as worktree,
} from "./local-version-control-system.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { message } from "./task-event-store-materialization.ts";

// Git tree scanning, flat/sharded object layout, and object-path helpers.
export interface EventEntry {
  readonly name: string;
  readonly oid: string;
}
export interface GitTreeEntry extends EventEntry {
  readonly mode: string;
}
const batchEventEntryCache = new WeakMap<
  LedgerGitLayout,
  { readonly commit: string; readonly entries: readonly EventEntry[] }
>();
export function cachedBatchEventEntries(ledger: LedgerGitLayout, commit: string): readonly EventEntry[] {
  const cached = batchEventEntryCache.get(ledger);
  if (cached?.commit === commit) return cached.entries;
  const entries = eventEntries(ledger, commit);
  batchEventEntryCache.set(ledger, { commit, entries });
  return entries;
}
export function eventEntries(ledger: LedgerGitLayout, commit: string): readonly EventEntry[] {
  const scan = scanEventsRoot(ledger, commit);
  if (scan === null) return [];
  if (scan.flat.length > 0 && scan.shards.length > 0) throw mixedLayoutError(scan);
  return scan.shards.length > 0
    ? eventEntriesFromShards(ledger, scan.shards)
    : scan.flat.map(({ name, oid }) => ({ name, oid }));
}
export interface LedgerRootScan {
  readonly treeSha: string;
  readonly flat: readonly GitTreeEntry[];
  readonly shards: readonly GitTreeEntry[];
}
/** The single layout ruler: one pass over an events or content-object root that classifies every
 * entry as flat, sharded, or invalid. The read path, the append layout choice, and migration
 * all derive their decisions from this scan, so they cannot disagree about what a layout is. */
export function scanEventsRoot(ledger: LedgerGitLayout, commit: string): LedgerRootScan | null {
  const tree = treeObjectAt(ledger.rootDir, `${commit}:${ledgerGitPath(ledger, "events")}`);
  if (tree === null) return null;
  const flat: GitTreeEntry[] = [],
    shards: GitTreeEntry[] = [];
  for (const entry of tree.entries) {
    if (entry.name === "head.json" && entry.mode === "100644") continue;
    if (entry.mode === "40000" && /^[0-9a-f]{2}$/u.test(entry.name)) {
      shards.push(entry);
      continue;
    }
    if (entry.mode === "100644" && entry.name.endsWith(".json")) {
      flat.push(entry);
      continue;
    }
    throw new TaskEventStoreError("invalid_store", `events root contains non-sharded entry ${entry.name}`);
  }
  return {
    treeSha: tree.oid,
    flat: flat.sort((left, right) => left.name.localeCompare(right.name)),
    shards: shards.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
export function scanContentRoot(ledger: LedgerGitLayout, commit: string): LedgerRootScan | null {
  const tree = treeObjectAt(ledger.rootDir, `${commit}:${ledgerGitPath(ledger, "objects/sha256")}`);
  if (tree === null) return null;
  const flat: GitTreeEntry[] = [],
    shards: GitTreeEntry[] = [];
  for (const entry of tree.entries) {
    if (entry.mode === "40000" && /^[0-9a-f]{2}$/u.test(entry.name)) {
      shards.push(entry);
      continue;
    }
    if (entry.mode === "100644" && /^[0-9a-f]{64}$/u.test(entry.name)) {
      flat.push(entry);
      continue;
    }
    throw new TaskEventStoreError(
      "invalid_store",
      `content object root contains invalid migration source ${entry.name}`,
    );
  }
  return {
    treeSha: tree.oid,
    flat: flat.sort((left, right) => left.name.localeCompare(right.name)),
    shards: shards.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
export function mixedLayoutError(scan: LedgerRootScan): TaskEventStoreError {
  return new TaskEventStoreError(
    "invalid_store",
    `events root mixes ${scan.flat.length} flat/v1 and ${scan.shards.length} sharded entries; ` +
      "run ha migrate ledger to normalize and migrate the ledger",
  );
}
export function writeLayoutAt(ledger: LedgerGitLayout, commit: string): LedgerObjectLayout {
  const scan = scanEventsRoot(ledger, commit);
  if (scan !== null && scan.flat.length > 0) {
    if (scan.shards.length > 0) throw mixedLayoutError(scan);
    return "flat/v1";
  }
  return "sharded-sha256-2/v1";
}
export function contentEntriesFromShards(
  ledger: LedgerGitLayout,
  shards: readonly GitTreeEntry[],
): readonly EventEntry[] {
  if (shards.length === 0) return [];
  const output = gitObjects.batch(ledger.rootDir, `${shards.map(({ oid }) => oid).join("\n")}\n`);
  const blobs: EventEntry[] = [];
  let cursor = 0;
  for (const shard of shards) {
    const parsed = batchTree(output, cursor);
    for (const entry of parsed.entries) {
      if (entry.mode !== "100644" || !/^[0-9a-f]{62}$/u.test(entry.name))
        throw new TaskEventStoreError(
          "invalid_store",
          `content shard ${shard.name} contains invalid entry ${entry.name}`,
        );
      blobs.push({ name: `${shard.name}/${entry.name}`, oid: entry.oid });
    }
    cursor = parsed.next;
  }
  return blobs.sort((left, right) => left.name.localeCompare(right.name));
}
export function eventEntriesFromShards(
  ledger: LedgerGitLayout,
  shards: readonly GitTreeEntry[],
): readonly EventEntry[] {
  if (shards.length === 0) return [];
  const output = gitObjects.batch(ledger.rootDir, `${shards.map(({ oid }) => oid).join("\n")}\n`);
  const events: EventEntry[] = [];
  let cursor = 0;
  for (const shard of shards) {
    const parsed = batchTree(output, cursor);
    for (const entry of parsed.entries) {
      const opId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (entry.mode !== "100644" || !opId || eventObjectShard(opId) !== shard.name)
        throw new TaskEventStoreError(
          "invalid_store",
          `event shard ${shard.name} contains invalid entry ${entry.name}`,
        );
      events.push({ name: `${shard.name}/${entry.name}`, oid: entry.oid });
    }
    cursor = parsed.next;
  }
  return events.sort((left, right) => left.name.localeCompare(right.name));
}
export function treeObjectAt(
  repoRoot: string,
  spec: string,
): { readonly oid: string; readonly entries: readonly GitTreeEntry[] } | null {
  const output = gitObjects.batch(repoRoot, `${spec}\n`);
  const headerEnd = output.indexOf(10);
  const header = output.subarray(0, headerEnd).toString("utf8");
  if (header.endsWith(" missing")) return null;
  const [oid, type] = header.split(" ");
  if (!oid || type !== "tree") throw new TaskEventStoreError("invalid_store", `${spec} is not a tree`);
  return { oid, entries: batchTree(output, 0).entries };
}
export function batchTree(
  output: Buffer,
  cursor: number,
): { readonly entries: readonly GitTreeEntry[]; readonly next: number } {
  const headerEnd = output.indexOf(10, cursor);
  const header = output.subarray(cursor, headerEnd).toString("utf8");
  const [, type, sizeText] = header.split(" ");
  const size = Number(sizeText);
  if (type !== "tree" || !Number.isSafeInteger(size))
    throw new TaskEventStoreError("invalid_store", "Git object is not a tree");
  const start = headerEnd + 1;
  const end = start + size;
  const entries: GitTreeEntry[] = [];
  let position = start;
  while (position < end) {
    const space = output.indexOf(32, position);
    const nul = output.indexOf(0, space + 1);
    const mode = output.subarray(position, space).toString("utf8");
    const name = output.subarray(space + 1, nul).toString("utf8");
    const oid = output.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    position = nul + 21;
  }
  return { entries, next: end + 1 };
}
export function firstEntryAfter(entries: readonly EventEntry[], cursor: string): number {
  let low = 0,
    high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle]!.name <= cursor) low = middle + 1;
    else high = middle;
  }
  return low;
}
export function checkedEventBytes(event: CanonicalEventV1): string {
  try {
    return serializeCanonicalEvent(event);
  } catch (error) {
    throw new TaskEventStoreError("invalid_store", message(error));
  }
}
export function eventObjectPath(
  ledger: LedgerGitLayout,
  opId: string,
  layout: LedgerObjectLayout = "sharded-sha256-2/v1",
): string {
  safeOpId(opId);
  return ledgerGitPath(ledger, eventObjectRelativePath(opId, layout));
}
export function blobObjectPath(
  ledger: LedgerGitLayout,
  sha256: string,
  layout: LedgerObjectLayout = "sharded-sha256-2/v1",
): string {
  return ledgerGitPath(ledger, contentObjectRelativePath(sha256, layout));
}
export function eventObjectPaths(ledger: LedgerGitLayout, opId: string): readonly [string, string] {
  return [eventObjectPath(ledger, opId), eventObjectPath(ledger, opId, "flat/v1")];
}
export function blobObjectPaths(ledger: LedgerGitLayout, sha256: string): readonly [string, string] {
  return [blobObjectPath(ledger, sha256), blobObjectPath(ledger, sha256, "flat/v1")];
}
export function readFirstPathAt(repoRoot: string, commit: string, targets: readonly string[]): Uint8Array | null {
  const output = gitObjects.batch(repoRoot, `${targets.map((target) => `${commit}:${target}`).join("\n")}\n`);
  let cursor = 0;
  for (const _target of targets) {
    const headerEnd = output.indexOf(10, cursor),
      header = output.subarray(cursor, headerEnd).toString("utf8");
    if (header.endsWith(" missing")) {
      cursor = headerEnd + 1;
      continue;
    }
    const size = Number(header.split(" ").at(-1)),
      start = headerEnd + 1;
    return output.subarray(start, start + size);
  }
  return null;
}
export function safeOpId(opId: string): void {
  if (!opId || opId === "head" || /[\\/]/u.test(opId) || opId === "." || opId === "..")
    throw new TaskEventStoreError("invalid_store", "event opId is not a safe object name");
}
function publicationRef(opId: string): string {
  return `refs/ha-event-prepared/${sha256Text(opId)}`;
}
