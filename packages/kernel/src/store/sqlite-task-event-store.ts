import { type EventHead, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { isTaskEvent, ledgerCommitSha, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { type HarnessLayoutInput } from "../layout/index.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { canonicalDocumentClaims, canonicalDocumentRetirements } from "./task-event-store-claims-layout.ts";
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
  const ledger = resolveLedgerGitLayout(input),
    sqlite = openSqliteEventStore({ repoId: options.repoId, rootInput: input }),
    branch = options.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
  const authoredRef = `refs/heads/${branch}`;
  let closed = false,
    follower = pendingFollower("Git follower has not published this ledger cut");

  const events = () => sqlite.events();
  const head = (): EventHead | null => {
    const event = events().at(-1);
    return event
      ? {
          revision: event.workspaceRevision,
          opId: event.opId,
          eventDigest: `sha256:${sha256Text(JSON.stringify(event))}`,
        }
      : null;
  };
  const cut = () => canonicalLedgerCut(options.repoId, head());
  const readContent = (sha256: string) => sqlite.readContentObject(sha256);
  const append = (bundle: CanonicalWriteBundle): CanonicalEventAppendReceipt => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    validateCanonicalWriteBundle(bundle);
    options.beforeAppend?.();
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
        });
    if (options.withAppendFence) options.withAppendFence(accept);
    else accept();
    follower = pendingFollower("Git follower has not verified the accepted ledger cut");
    try {
      publishFollower();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      consumeKnownError(error);
      follower = pendingFollower(reason);
      options.onMaterializationHealthChange?.(health("failed", reason));
    }
    return {
      status: "applied",
      event: bundle.event,
      revision: bundle.event.workspaceRevision,
      commitSha: follower.git.commitSha ? ledgerCommitSha(options.repoId, follower.git.commitSha) : null,
      cut: canonicalEventCut(options.repoId, bundle.event),
      metrics: { gitProcesses: 0, nodeSyncs: 0, changedPaths: [] },
    };
  };

  const publishFollower = () => {
    const accepted = cut(),
      allEvents = events(),
      files = followerFiles(ledger, allEvents, readContent, accepted),
      parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
      tempRef = publicationRef(`outbox-${accepted.revision}-${accepted.headDigest}`),
      commit = prepareCommit(
        ledger.rootDir,
        tempRef,
        parent,
        files,
        `outbox-${accepted.revision}`,
        new Date().toISOString(),
      );
    settleFiles(ledger.rootDir, commit, files);
    updateRef(ledger.rootDir, authoredRef, commit, parent);
    deleteRef(ledger.rootDir, tempRef);
    const manifest = files.find((file) => "target" in file && file.target.endsWith("events/segments/manifest.json"));
    if (!manifest || !("target" in manifest)) throw new Error("outbox manifest is absent");
    const gitReadback =
      localGitObjectRefStore.readPath(ledger.rootDir, commit, manifest.target)?.toString("utf8") ?? null;
    const worktreeReadback = localGitWorktreeSettlement.readNode(`${ledger.rootDir}/${manifest.target}`)?.body ?? null;
    if (gitReadback !== manifest.body || worktreeReadback !== manifest.body)
      throw new Error("Git follower independent read-back did not match its manifest");
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      worktree: { status: "verified", cut: accepted, commitSha: commit, conflicts: [] },
    };
    options.onMaterializationHealthChange?.(health("ok"));
    void Promise.resolve(options.afterFlush?.(null, null)).catch((error: unknown) => consumeKnownError(error));
    return {
      status: "visible" as const,
      commitSha: ledgerCommitSha(options.repoId, commit),
      changed: [],
      conflicts: [],
    };
  };

  return {
    canonicalRef: "sqlite:generation-1",
    read: () => ({ schema: "canonical-event-stream/v1", revision: sqlite.revision(), events: events() }),
    readHead: head,
    currentCut: cut,
    currentCommit: () =>
      ledgerCommitSha(options.repoId, localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef)),
    publication: (event) => ({ commitSha: null, cut: canonicalEventCut(options.repoId, event) }),
    revisionAt: () => null,
    readEvent: (opId) => events().find((event) => event.opId === opId) ?? null,
    readTaskEvent: (opId) => {
      const event = events().find((candidate) => candidate.opId === opId);
      return event && isTaskEvent(event) ? event : null;
    },
    readBatch: (cursor, maxItems) => sqliteBatch(events(), cursor, maxItems, readContent),
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
  events: readonly CanonicalEventV1[],
  readContent: (sha256: string) => Uint8Array | null,
  cut: LedgerCutIdentity,
): PublicationFile[] {
  const latest = new Map<string, { body: string; mode: "100644" | "120000" }>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) latest.delete(retirement.path);
    for (const claim of canonicalDocumentClaims(event)) {
      const bytes = readContent(claim.sha256);
      if (!bytes) throw new TaskEventStoreError("invalid_store", `content object ${claim.sha256} is missing`);
      latest.set(claim.path, {
        body: Buffer.from(bytes).toString("utf8"),
        mode: canonicalDocumentMode(event, claim.path),
      });
    }
  }
  const manifest = `${JSON.stringify({ schema: "sqlite-ledger-segment-manifest/v1", generation: 1, cut })}\n`;
  return [
    ...[...latest].map(([target, value]) => ({ target: ledgerGitPath(ledger, target), ...value })),
    { target: ledgerGitPath(ledger, "events/segments/manifest.json"), body: manifest, mode: "100644" },
  ];
}

function sqliteBatch(
  events: readonly CanonicalEventV1[],
  cursor: string | null,
  maxItems: number,
  readContent: (sha256: string) => Uint8Array | null,
): EventFileBatch {
  const start = cursor === null ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(maxItems) || maxItems < 1)
    throw new TaskEventStoreError("invalid_store", "event batch cursor or size is invalid");
  const selected = events.slice(start, start + maxItems),
    next = start + selected.length;
  return {
    sourceRevision: events.length,
    events: selected,
    cursor: selected.length ? String(next) : cursor,
    done: next >= events.length,
    accessedItems: selected.length,
    prefetchContent: (replay) =>
      new Map(
        replay.flatMap((event) =>
          canonicalDocumentClaims(event).map((claim) => [claim.sha256, readContent(claim.sha256)]),
        ),
      ),
  };
}
