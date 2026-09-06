import { type EventHead, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import {
  isTaskEvent,
  ledgerCommitSha,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { type HarnessLayoutInput } from "../layout/index.ts";
import { consumeKnownError } from "../error-consumption.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  contentClaims,
} from "./task-event-store-claims-layout.ts";
import { canonicalDocumentMode, settleFiles } from "./task-event-store-materialization.ts";
import { canonicalEventCut, canonicalLedgerCut } from "./task-event-store-reads.ts";
import { prepareCommit, publicationRef, updateRef, deleteRef } from "./task-event-store-git-refs.ts";
import { resolveLedgerGitLayout, ledgerGitPath } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { openSqliteEventStore, type SqliteCommandOutcome } from "./sqlite-event-store.ts";
import { validateCanonicalWriteBundle } from "./task-event-store-contract.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  CanonicalWriteBundle,
  EventFileBatch,
  MaterializationHealth,
  PublicationFile,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";

export interface DaemonWriterFence {
  readonly repoId: string;
  readonly holderId: string;
  readonly epoch: number;
}

export interface FollowerFacet {
  readonly status: "pending" | "verified";
  readonly cut: LedgerCutIdentity | null;
  readonly commitSha: string | null;
  readonly reason?: string;
  readonly conflicts?: readonly string[];
}

export interface SqliteCanonicalEventStore extends CanonicalEventStore {
  readonly readCommandOutcome: (opId: string) => SqliteCommandOutcome | null;
  readonly ledgerMetadata: () => { readonly repoId: string; readonly generation: number; readonly revision: number };
  readonly followerStatus: () => { readonly git: FollowerFacet; readonly worktree: FollowerFacet };
  readonly acceptMaterializedCut: (input: unknown) => void;
}

export interface SqliteTaskEventStoreOptions {
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly writerFence?: () => DaemonWriterFence;
  readonly beforeAppend?: () => void;
  readonly withAppendFence?: <T>(operation: () => T) => T;
  readonly afterFlush?: (actor: unknown, inventory: unknown | null) => void | Promise<void>;
  readonly onMaterializationHealthChange?: (health: MaterializationHealth) => void;
  readonly mutable?: boolean;
  readonly killpoint?: (point: import("./task-event-store-types.ts").EventPublicationKillpoint) => void;
}

export function makeSqliteTaskEventStore(options: SqliteTaskEventStoreOptions): SqliteCanonicalEventStore {
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("canonical event store requires rootInput or rootDir");
  const sqlite = openSqliteEventStore({
    repoId: options.repoId,
    rootInput: input,
    readOnly: options.mutable === false,
  });
  let resolvedLedger: ReturnType<typeof resolveLedgerGitLayout> | null = null;
  const ledger = () => (resolvedLedger ??= resolveLedgerGitLayout(input));
  const authoredRef = () => {
    const current = ledger(),
      branch = options.authoredBranch ?? localGitObjectRefStore.currentBranch(current.rootDir);
    if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
    return `refs/heads/${branch}`;
  };
  let closed = false,
    follower = pendingFollower("Git follower has not published this ledger cut");

  const head = (): EventHead | null => {
    const event = sqlite.eventAtRevision(sqlite.revision());
    return event
      ? {
          revision: event.workspaceRevision,
          opId: event.opId,
          eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
        }
      : null;
  };
  const cut = () => canonicalLedgerCut(options.repoId, head());
  const readContent = (sha256: string) => sqlite.readContentObject(sha256);
  const append = (bundle: CanonicalWriteBundle): CanonicalEventAppendReceipt => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    validateCanonicalWriteBundle(bundle);
    options.beforeAppend?.();
    options.killpoint?.("before_event_write");
    const members = [...(bundle.preceding ?? []), bundle],
      appended = members.map((member) => member.event),
      blobs = members.flatMap((member) => member.blobs),
      fence = options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 },
      accept = () =>
        sqlite.appendCommand({
          fence: { repoId: fence.repoId, holder: fence.holderId, epoch: fence.epoch },
          intent: {
            opId: bundle.event.opId,
            intentDigest: `sha256:${sha256Text(JSON.stringify(appended))}`,
            summary: bundle.event.type,
          },
          events: appended,
          blobs,
          beforeOutcome: () => options.killpoint?.("after_event_write"),
        });
    if (options.withAppendFence) options.withAppendFence(accept);
    else accept();
    options.killpoint?.("after_sqlite_commit");
    follower = pendingFollower("Git follower has not verified the accepted ledger cut");
    try {
      publishFollower(appended);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      consumeKnownError(error);
      follower = pendingFollower(reason);
      options.onMaterializationHealthChange?.(health("failed", reason));
    }
    options.killpoint?.("before_response_write");
    const receipt: CanonicalEventAppendReceipt = {
      status: "applied",
      event: bundle.event,
      revision: bundle.event.workspaceRevision,
      commitSha: follower.git.commitSha ? ledgerCommitSha(options.repoId, follower.git.commitSha) : null,
      cut: canonicalEventCut(options.repoId, bundle.event),
      metrics: { gitProcesses: 0, nodeSyncs: 0, changedPaths: [] },
    };
    options.killpoint?.("after_response_write");
    return receipt;
  };

  const publishFollower = (suffix?: readonly CanonicalEventV1[]) => {
    const accepted = cut(),
      currentLedger = ledger(),
      currentRef = authoredRef(),
      parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, currentRef),
      pendingEvents = suffix ?? readPendingEvents(sqlite, readFollowerRevision(currentLedger, parent)),
      files = followerFiles(currentLedger, parent, pendingEvents, readContent, accepted),
      tempRef = publicationRef(`outbox-${accepted.revision}-${accepted.headDigest}`),
      commit = prepareCommit(
        currentLedger.rootDir,
        tempRef,
        parent,
        files,
        `outbox-${accepted.revision}`,
        new Date().toISOString(),
      );
    const dirty = localGitWorktreeSettlement.hasChanges(currentLedger.rootDir, currentLedger.authoredPrefix || ".");
    updateRef(currentLedger.rootDir, currentRef, commit, parent);
    deleteRef(currentLedger.rootDir, tempRef);
    verifyGitFiles(currentLedger.rootDir, commit, files);
    if (!dirty) settleFiles(currentLedger.rootDir, commit, files);
    const manifest = files.find((file) => "target" in file && file.target.endsWith("events/segments/manifest.json"));
    if (!manifest || !("target" in manifest)) throw new Error("outbox manifest is absent");
    const gitReadback =
      localGitObjectRefStore.readPath(currentLedger.rootDir, commit, manifest.target)?.toString("utf8") ?? null;
    const worktreeReadback =
      localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${manifest.target}`)?.body ?? null;
    if (gitReadback !== manifest.body) throw new Error("Git follower manifest read-back did not match");
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      worktree:
        !dirty && worktreeReadback === manifest.body
          ? { status: "verified", cut: accepted, commitSha: commit, conflicts: [] }
          : { status: "pending", cut: null, commitSha: commit, reason: "authored worktree has concurrent edits" },
    };
    options.onMaterializationHealthChange?.(health("ok"));
    return {
      status: "visible" as const,
      commitSha: ledgerCommitSha(options.repoId, commit),
      changed: [],
      conflicts: [],
    };
  };

  return {
    canonicalRef: "sqlite:generation-1",
    read: () => ({ schema: "canonical-event-stream/v1", revision: sqlite.revision(), events: sqlite.events() }),
    readHead: head,
    currentCut: cut,
    currentCommit: () =>
      ledgerCommitSha(options.repoId, localGitObjectRefStore.resolveCommit(ledger().rootDir, authoredRef())),
    publication: (event) => ({ commitSha: null, cut: canonicalEventCut(options.repoId, event) }),
    revisionAt: () => null,
    readEvent: sqlite.event,
    readTaskEvent: (opId) => {
      const event = sqlite.event(opId);
      return event && isTaskEvent(event) ? event : null;
    },
    readBatch: (cursor, maxItems) => sqliteBatch(sqlite, cursor, maxItems, readContent),
    readContentBlob: readContent,
    layout: () => "sharded-sha256-2/v1",
    append,
    migrateLayout: () => {
      throw new TaskEventStoreError("legacy_shape", "in-place event-shape migration is retired");
    },
    recover: () => ({ status: "none", publications: 0, elapsedMs: 0 }),
    materialize: publishFollower,
    materializationHealth: () => health(follower.git.status === "verified" ? "ok" : "failed", follower.git.reason),
    drain: async () => {
      if (!closed) sqlite.close();
      closed = true;
    },
    readCommandOutcome: sqlite.readCommandOutcome,
    ledgerMetadata: sqlite.metadata,
    followerStatus: () => follower,
    acceptMaterializedCut: () => {
      throw new TaskEventStoreError("legacy_shape", "Git event cuts are retired");
    },
  };

  function health(state: "ok" | "failed", reason?: string): MaterializationHealth {
    return {
      state,
      lastCheckpointRevision: follower.git.cut?.revision ?? 0,
      lastCheckpointAt: follower.git.status === "verified" ? new Date().toISOString() : null,
      pendingWalEvents: sqlite.revision() - (follower.git.cut?.revision ?? 0),
      ...(reason ? { reason: "deterministic_failure", lastError: reason } : {}),
    };
  }
}

function pendingFollower(reason: string): { readonly git: FollowerFacet; readonly worktree: FollowerFacet } {
  return {
    git: { status: "pending", cut: null, commitSha: null, reason },
    worktree: { status: "pending", cut: null, commitSha: null, reason },
  };
}

function followerFiles(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  parent: string,
  events: readonly CanonicalEventV1[],
  readContent: (sha256: string) => Uint8Array | null,
  cut: LedgerCutIdentity,
): PublicationFile[] {
  const latest = new Map<string, { body: string; mode: "100644" | "120000" }>(),
    retired = new Set<string>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) {
      latest.delete(retirement.path);
      retired.add(retirement.path);
    }
    for (const claim of canonicalDocumentClaims(event)) {
      const bytes = readContent(claim.sha256);
      if (!bytes) throw new TaskEventStoreError("invalid_store", `content object ${claim.sha256} is missing`);
      latest.set(claim.path, {
        body: Buffer.from(bytes).toString("utf8"),
        mode: canonicalDocumentMode(event, claim.path),
      });
      retired.delete(claim.path);
    }
  }
  const manifest = `${JSON.stringify({ schema: "sqlite-ledger-segment-manifest/v1", generation: 1, cut })}\n`;
  const eventsPrefix = ledgerGitPath(ledger, "events/"),
    objectsPrefix = ledgerGitPath(ledger, "objects/sha256/");
  for (const entry of localGitObjectRefStore.listTree(ledger.rootDir, parent)) {
    if (
      (entry.target.startsWith(eventsPrefix) && !entry.target.endsWith("events/segments/manifest.json")) ||
      entry.target.startsWith(objectsPrefix)
    )
      retired.add(entry.target);
  }
  return [
    ...[...latest].map(([target, value]) => ({ target: ledgerGitPath(ledger, target), ...value })),
    ...[...retired].map((target) => ({
      delete: target.startsWith(ledger.authoredPrefix) ? target : ledgerGitPath(ledger, target),
    })),
    { target: ledgerGitPath(ledger, "events/segments/manifest.json"), body: manifest, mode: "100644" },
  ];
}

function sqliteBatch(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  cursor: string | null,
  maxItems: number,
  readContent: (sha256: string) => Uint8Array | null,
): EventFileBatch {
  const start = cursor === null ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(maxItems) || maxItems < 1)
    throw new TaskEventStoreError("invalid_store", "event batch cursor or size is invalid");
  const selected = sqlite.eventsAfter(start, maxItems),
    next = start + selected.length;
  return {
    sourceRevision: sqlite.revision(),
    events: selected,
    cursor: selected.length ? String(next) : cursor,
    done: next >= sqlite.revision(),
    accessedItems: selected.length,
    prefetchContent: (replay) =>
      new Map(
        replay.flatMap((event) => contentClaims(event).map((claim) => [claim.sha256, readContent(claim.sha256)])),
      ),
  };
}

function readPendingEvents(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
): readonly CanonicalEventV1[] {
  const events: CanonicalEventV1[] = [];
  let cursor = revision;
  for (;;) {
    const page = sqlite.eventsAfter(cursor);
    events.push(...page);
    if (page.length < 4096) return events;
    cursor = page.at(-1)!.workspaceRevision;
  }
}

function readFollowerRevision(ledger: ReturnType<typeof resolveLedgerGitLayout>, commit: string): number {
  const target = ledgerGitPath(ledger, "events/segments/manifest.json"),
    bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, target);
  if (!bytes) return 0;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      readonly generation?: unknown;
      readonly cut?: { revision?: unknown };
    };
    return parsed.generation === 1 && Number.isSafeInteger(parsed.cut?.revision) ? Number(parsed.cut?.revision) : 0;
  } catch (error) {
    consumeKnownError(error);
    return 0;
  }
}

function verifyGitFiles(repoRoot: string, commit: string, files: readonly PublicationFile[]): void {
  const modes = new Map(localGitObjectRefStore.listTree(repoRoot, commit).map((entry) => [entry.target, entry.mode]));
  for (const file of files) {
    if ("target" in file) {
      const body = localGitObjectRefStore.readPath(repoRoot, commit, file.target)?.toString("utf8") ?? null;
      if (body !== file.body || modes.get(file.target) !== file.mode)
        throw new Error(`Git follower read-back differs at ${file.target}`);
    } else if ("delete" in file && localGitObjectRefStore.readPath(repoRoot, commit, file.delete) !== null) {
      throw new Error(`Git follower did not retire ${file.delete}`);
    }
  }
}
