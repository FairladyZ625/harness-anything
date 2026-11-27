import { authoredNodeFingerprint, readAuthoredNode } from "../authored-node-read.ts";
import { isFrozenWritePlan, type EventHead } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import {
  isTaskEvent,
  ledgerCommitSha,
  type LedgerCommitSha,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { isSettingsEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import {
  canonicalDocumentClaims,
  contentClaims,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import {
  canonicalEventCut,
  canonicalEventCutFromHead,
  canonicalLedgerCut,
  validateCanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  CanonicalWriteBundle,
  EventFileBatch,
  MaterializationHealth,
  MaterializationReceipt,
  MaterializationRequest,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { SqliteStorageBackendConfig } from "../storage-backend.ts";
import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { SqliteCommandOutcome, SqliteEventStore, SqliteOutboxBaseline } from "./sqlite-event-store-types.ts";
import { assertAuthorizedReplacements } from "./task-event-store-replacement-authorization.ts";

export interface DaemonWriterFence {
  readonly repoId: string;
  readonly holderId: string;
  readonly epoch: number;
}

/** Per-append layout already resolved by the trusted host; never a cross-thread callback. */
export interface SqliteAppendPreparation {
  readonly authoredRoot: string;
}

export interface SqliteCanonicalEventStore extends CanonicalEventStore {
  readonly append: (bundle: CanonicalWriteBundle, preparation?: SqliteAppendPreparation) => CanonicalEventAppendReceipt;
  readonly readCommandOutcome: (opId: string) => SqliteCommandOutcome | null;
  readonly readDocumentRetirementRevision: SqliteEventStore["readDocumentRetirementRevision"];
  readonly verifyRevisionContinuity: SqliteEventStore["verifyRevisionContinuity"];
  /** Drops replication-log rows below the sequence; the writer's retention call, never a reader's. */
  readonly pruneReplicationLog: (beforeSequence: number) => void;
  readonly gitOutboxState?: SqliteEventStore["gitOutboxState"];
}

export interface MaterializationDocumentDescriptor {
  readonly retired?: boolean;
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly policyId: string | null;
}

export interface SqliteGitFollowerHandle {
  readonly currentCommit: () => LedgerCommitSha | null;
  readonly followerStatus: CanonicalEventStore["followerStatus"];
  readonly materialize: CanonicalEventStore["materialize"];
  readonly materializationHealth: CanonicalEventStore["materializationHealth"];
  readonly settlePendingMaterialization: NonNullable<CanonicalEventStore["settlePendingMaterialization"]>;
  readonly onAppend: (acceptedBaseline: ReadonlyMap<string, SqliteOutboxBaseline>, revision?: number) => void;
  readonly request: () => void;
  readonly drain: () => Promise<void>;
}

export interface SqliteGitFollowerMountContext {
  readonly input: HarnessLayoutInput;
  readonly options: SqliteTaskEventStoreOptions;
  readonly sqlite: SqliteEventStore;
  readonly head: () => EventHead | null;
  readonly cut: () => ReturnType<typeof canonicalLedgerCut>;
  readonly readContent: (sha256: string) => Uint8Array | null;
  readonly latestAppendLayout: () => ReturnType<typeof resolveHarnessLayout> | null;
}

export interface SqliteTaskEventStoreOptions {
  readonly storage?: SqliteStorageBackendConfig;
  /** Host adapter: canonical mutations are accepted only by its dedicated Writer Isolate. */
  readonly canonicalWriter?: Required<Pick<SqliteCanonicalEventStore, "append" | "appendRejection">> & {
    readonly pruneReplicationLog: (beforeSequence: number) => void;
  };
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly writerFence?: () => DaemonWriterFence;
  readonly activationPreflight?: (input: { readonly rootInput: HarnessLayoutInput; readonly repoId: string }) => void;
  readonly withAppendFence?: <T>(operation: () => T) => T;
  /** Host publication excludes epoch takeover independently of canonical append. */
  readonly withFollowerFence?: <T>(operation: () => T) => T;
  /** Asynchronous follower fence for non-blocking background Git mutations. */
  readonly withFollowerFenceAsync?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly onMaterializationHealthChange?: (health: MaterializationHealth) => void;
  readonly mutable?: boolean;
  readonly generation?: 1 | 2 | 3;
  readonly killpoint?: (
    point: import("@harness-anything/kernel/internal/ports/task-event-store.ts").EventPublicationKillpoint,
  ) => void;
  readonly onOpenProgress?: (progress: { readonly applied: number; readonly total: number }) => void;
  /** Current active projection documents; null means the projection has not reached the accepted cut yet. */
  readonly readMaterializationDocuments?: (
    includePolicySkippedPaths?: readonly string[],
    afterRevision?: number,
    expectedRevision?: number,
    previouslyMaterializedPaths?: readonly string[],
    reconcileNodePolicy?: boolean,
  ) => readonly MaterializationDocumentDescriptor[] | null;
  /** Optional host/legacy Git follower attachment. Pure SQLite writer-cells omit this to stay subprocess-free. */
  readonly attachGitFollower?: (context: SqliteGitFollowerMountContext) => SqliteGitFollowerHandle;
}

/**
 * Pure Stage 2 SQLite canonical event store: validates replacements in-process via `node:fs` + WAL transactions
 * and records durable `git_outbox` state atomically without spawning Git subprocesses.
 */
export function makeSqliteTaskEventStore(options: SqliteTaskEventStoreOptions): SqliteCanonicalEventStore {
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("canonical event store requires rootInput or rootDir");
  if (options.mutable !== false) options.activationPreflight?.({ rootInput: input, repoId: options.repoId });
  const sqlite = openSqliteEventStore({
    repoId: options.repoId,
    rootInput: input,
    readOnly: options.mutable === false,
    generation: options.generation,
    onOpenProgress: options.onOpenProgress,
  });
  let latestAppendLayout: ReturnType<typeof resolveHarnessLayout> | null = null;
  let closed = false;

  const head = (): EventHead | null => sqlite.headIdentity();
  const cut = () => canonicalLedgerCut(options.repoId, head());
  const readContent = (sha256: string) => sqlite.readContentObject(sha256);

  const gitFollower = options.attachGitFollower?.({
    input,
    options,
    sqlite,
    head,
    cut,
    readContent,
    latestAppendLayout: () => latestAppendLayout,
  });

  const append = (bundle: CanonicalWriteBundle, preparation?: SqliteAppendPreparation): CanonicalEventAppendReceipt => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    if (options.canonicalWriter) {
      // Clone erases freeze markers, so this check belongs before transport.
      // Event/content validation belongs to the authoritative store reached by
      // the commit port; hashing the same blobs here duplicates that boundary.
      for (const member of [...(bundle.preceding ?? []), bundle])
        if (!isFrozenWritePlan(member.plan))
          throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle requires one frozen write plan");
      latestAppendLayout = resolveHarnessLayout(input);
      // Host fault hooks can veto preparation, but cannot call back from the isolated transaction.
      // Transaction-internal rollback hooks remain on the direct storage contract under test.
      options.killpoint?.("before_event_write");
      options.killpoint?.("after_event_write");
      const receipt = options.canonicalWriter.append(bundle, { authoredRoot: latestAppendLayout.authoredRoot });
      try {
        options.killpoint?.("after_store_commit");
        gitFollower?.request();
        options.killpoint?.("before_response_write");
        options.killpoint?.("after_response_write");
        return receipt;
      } catch (error) {
        throw Object.assign(
          new TaskEventStoreError("publication_indeterminate", error instanceof Error ? error.message : String(error)),
          { opId: bundle.event.opId, cause: error },
        );
      }
    }
    validateCanonicalWriteBundle(bundle);
    options.killpoint?.("before_event_write");
    const members = [...(bundle.preceding ?? []), bundle],
      appended = members.map((member) => member.event),
      blobs = members.flatMap((member) => member.blobs),
      revisionBeforeAcceptance = gitFollower ? sqlite.revision() : 0,
      appendLayout = preparation && !gitFollower ? null : resolveHarnessLayout(input),
      authoredRoot = appendLayout?.authoredRoot ?? preparation!.authoredRoot,
      acceptedBaseline = new Map<string, SqliteOutboxBaseline>();
    if (appendLayout) latestAppendLayout = appendLayout;
    assertAuthorizedReplacements(
      {
        eventExists: (opId) => sqlite.event(opId) !== null,
        documentHead: (target) => sqlite.documentHead(target, true),
        readContentObject: sqlite.readContentObject,
        local: (target) => {
          const node = readAuthoredNode(`${authoredRoot}/${target}`);
          return node && { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" };
        },
      },
      members,
    );
    for (const event of appended) {
      const task = isTaskEvent(event),
        settings = isSettingsEvent(event);
      for (const claim of canonicalDocumentClaims(event)) {
        const prose =
          !task &&
          event.schema === "doc-event/v1" &&
          event.payload.changes.some(
            (change) => change.path === claim.path && change.policyId === "markdown-body-replaceable/v1",
          );
        if (!task && event.schema !== "doc-event/v1" && !settings) continue;
        const node = readAuthoredNode(`${authoredRoot}/${claim.path}`);
        if (!node || node.mode !== "100644") continue;
        const matches =
          task ||
          node.sha256 === claim.sha256 ||
          (prose && node.body.includes("\r\n") && sha256Text(node.body.replace(/\r\n/gu, "\n")) === claim.sha256) ||
          (settings && node.sha256 === event.payload.baseDocumentSha256);
        if (matches) acceptedBaseline.set(claim.path, { fingerprint: authoredNodeFingerprint(node), preserve: task });
      }
    }
    const fence = options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 },
      accept = () =>
        sqlite.appendValidatedBundle({
          fence: { repoId: fence.repoId, holder: fence.holderId, epoch: fence.epoch },
          events: appended,
          blobs,
          outboxBaselines: acceptedBaseline,
          beforeOutcome: () => options.killpoint?.("after_event_write"),
        });
    if (options.withAppendFence) options.withAppendFence(accept);
    else accept();
    const committedRevision = appended.at(-1)?.workspaceRevision ?? 0;
    if (gitFollower && committedRevision > revisionBeforeAcceptance)
      gitFollower.onAppend(acceptedBaseline, committedRevision);
    try {
      options.killpoint?.("after_store_commit");
      gitFollower?.request();
      options.killpoint?.("before_response_write");
      const currentFollower = gitFollower?.followerStatus();
      const receipt: CanonicalEventAppendReceipt = {
        status: "applied",
        event: bundle.event,
        revision: bundle.event.workspaceRevision,
        commitSha:
          currentFollower &&
          currentFollower.git.status === "verified" &&
          currentFollower.git.cut !== null &&
          currentFollower.git.cut.revision >= bundle.event.workspaceRevision &&
          currentFollower.git.commitSha
            ? (gitFollower?.currentCommit() ?? null)
            : null,
        cut: canonicalEventCutFromHead(options.repoId, sqlite.eventIdentity(bundle.event.opId)!),
        metrics: { gitProcesses: 0, nodeSyncs: 0, changedPaths: [] },
      };
      options.killpoint?.("after_response_write");
      return receipt;
    } catch (error) {
      throw Object.assign(
        new TaskEventStoreError("publication_indeterminate", error instanceof Error ? error.message : String(error)),
        { opId: bundle.event.opId, cause: error },
      );
    }
  };

  const appendRejection: CanonicalEventStore["appendRejection"] = (value) => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    if (options.canonicalWriter) return options.canonicalWriter.appendRejection(value);
    const fence = options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 },
      operation = () =>
        sqlite.appendCommand({
          fence: { repoId: fence.repoId, holder: fence.holderId, epoch: fence.epoch },
          intent: { opId: value.opId, intentDigest: value.intentDigest, summary: value.summary },
          events: [],
          rejectionCode: value.rejectionCode,
        });
    return options.withAppendFence ? options.withAppendFence(operation) : operation();
  };

  const outboxFallbackStatus = () => {
    const outbox = sqlite.gitOutboxState();
    const pendingReason =
      outbox.pendingRevision > outbox.publishedRevision
        ? "Awaiting host Git outbox publication"
        : "Git follower is host-managed outside writer-cell";
    return pendingFollower(pendingReason);
  };

  const emptyHealth = (): MaterializationHealth => {
    const outbox = sqlite.gitOutboxState(),
      revision = sqlite.revision(),
      pending = Math.max(0, revision - outbox.publishedRevision);
    return {
      state: pending > 0 ? "retrying" : "ok",
      lastCheckpointRevision: outbox.publishedRevision,
      lastCheckpointAt: null,
      pendingWalEvents: pending,
    };
  };

  return {
    canonicalRef: `sqlite:generation-${sqlite.metadata().generation}`,
    read: () => ({ schema: "canonical-event-stream/v1", revision: sqlite.revision(), events: sqlite.events() }),
    readHead: head,
    currentCut: cut,
    currentCommit: () => {
      if (gitFollower) return gitFollower.currentCommit();
      const sha = sqlite.gitOutboxState().publishedCommitSha;
      return sha ? ledgerCommitSha(options.repoId, sha) : null;
    },
    publication: (event) => ({ commitSha: null, cut: canonicalEventCut(options.repoId, event) }),
    appendRejection,
    readEvent: sqlite.event,
    readEventById: sqlite.eventById,
    readEventAtRevision: sqlite.eventAtRevision,
    queryEvents: sqlite.queryEvents,
    readEntityDeclarations: sqlite.readEntityDeclarations,
    readTaskEvent: (opId) => {
      const event = sqlite.event(opId);
      return event && isTaskEvent(event) ? event : null;
    },
    readBatch: (cursor, maxItems) => sqliteEventBatch(sqlite, cursor, maxItems, readContent),
    verifyRevisionContinuity: sqlite.verifyRevisionContinuity,
    readEventWindow: sqlite.readEventWindow,
    readContentBlob: readContent,
    readContentBlobRange: (sha256, offset, maxBytes) => sqlite.readContentObjectRange(sha256, offset, maxBytes),
    readContentBlobSize: (sha256) => sqlite.readContentObjectSize(sha256),
    readAttachMigrationScanWatermarks: sqlite.attachMigrationScanWatermarks,
    recordAttachMigrationScanWatermarks: (watermarks) => {
      if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
      const record = () => sqlite.recordAttachMigrationScanWatermarks(watermarks);
      if (options.withAppendFence) options.withAppendFence(record);
      else record();
    },
    layout: () => "sharded-sha256-2/v1",
    append,
    lastAppendLayout: () => latestAppendLayout,
    materialize: (request?: MaterializationRequest): MaterializationReceipt =>
      gitFollower
        ? gitFollower.materialize(request ?? {})
        : { status: request?.preview ? "planned" : "visible", commitSha: null, settlements: [], conflicts: [] },
    materializationHealth: () => (gitFollower ? gitFollower.materializationHealth() : emptyHealth()),
    drain: async () => {
      if (gitFollower) await gitFollower.drain();
      if (!closed) sqlite.close();
      closed = true;
    },
    settlePendingMaterialization: async (context) => {
      if (gitFollower) await gitFollower.settlePendingMaterialization(context);
    },
    readCommandOutcome: sqlite.readCommandOutcome,
    readDocumentRetirementRevision: sqlite.readDocumentRetirementRevision,
    ledgerMetadata: sqlite.metadata,
    followerStatus: () => (gitFollower ? gitFollower.followerStatus() : outboxFallbackStatus()),
    gitOutboxState: sqlite.gitOutboxState,
    pruneReplicationLog: (beforeSequence) => {
      if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
      if (options.canonicalWriter) options.canonicalWriter.pruneReplicationLog(beforeSequence);
      else sqlite.pruneReplicationLog(beforeSequence);
    },
  };
}

export function pendingFollower(reason: string): ReturnType<CanonicalEventStore["followerStatus"]> {
  return {
    git: { status: "pending", cut: null, commitSha: null, reason },
    worktree: { status: "pending", cut: null, commitSha: null, reason },
  };
}

export function sqliteEventBatch(
  sqlite: SqliteEventStore,
  cursor: string | null,
  maxItems: number,
  readContent: (sha256: string) => Uint8Array | null,
): EventFileBatch {
  const start = cursor === null ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(maxItems) || maxItems < 1)
    throw new TaskEventStoreError("invalid_store", "event batch cursor or size is invalid");
  const { selected, sourceRevision } = sqlite.readSnapshot(() => ({
      selected: sqlite.eventsAfter(start, maxItems),
      sourceRevision: sqlite.revision(),
    })),
    next = selected.at(-1)?.workspaceRevision ?? start;
  return {
    sourceRevision,
    events: selected,
    cursor: selected.length ? String(next) : cursor,
    done: next >= sourceRevision,
    accessedItems: selected.length,
    prefetchContent: (replay) =>
      new Map(
        replay.flatMap((event) => contentClaims(event).map((claim) => [claim.sha256, readContent(claim.sha256)])),
      ),
  };
}
