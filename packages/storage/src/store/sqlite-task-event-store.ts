import { DatabaseSync } from "node:sqlite";
import { type EventHead } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { isTaskEvent, ledgerCommitSha } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";
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
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { resolveLedgerGitLayout, ledgerGitPath, ledgerAuthoredPath } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { openSqliteEventStore, type SqliteCommandOutcome } from "./sqlite-event-store.ts";
import { validateCanonicalWriteBundle } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  CanonicalWriteBundle,
  EventFileBatch,
  MaterializationHealth,
  MaterializationReceipt,
  MaterializationRequest,
  PublicationWrite,
  PublicationDelete,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { SqliteStorageBackendConfig } from "../storage-backend.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { legacyDispatchLifecycleMigrationSessions } from "./dispatch-lifecycle-migration-index.ts";
import { assertAuthorizedReplacements } from "./task-event-store-replacement-authorization.ts";
import { createDurableFollowerPublisher } from "./durable-follower-publisher.ts";
import { publishFollowerCut } from "./task-event-store-git-refs.ts";
import {
  closureFiles,
  planFollowerSettlement,
  recoverGeneratedWorktreeBaseline,
  restoreRequestedDocuments,
  settlementRows,
  settledFingerprint,
} from "./sqlite-task-event-materialize.ts";
import {
  certifiedFollowerRevision,
  captureGitBaseline,
  followerDirectories,
  legacyRetirements,
  ledgerWorktreeBaseline,
  physicalWorktreeRevision,
  settleWorktree,
  settleWorktreeDirectories,
  worktreeFingerprint,
  type FollowerDirectorySettlement,
} from "./sqlite-task-event-publication.ts";

export interface DaemonWriterFence {
  readonly repoId: string;
  readonly holderId: string;
  readonly epoch: number;
}

export interface SqliteCanonicalEventStore extends CanonicalEventStore {
  readonly readCommandOutcome: (opId: string) => SqliteCommandOutcome | null;
  /** Drops replication-log rows below the sequence; the writer's retention call, never a reader's. */
  readonly pruneReplicationLog: (beforeSequence: number) => void;
}

export interface SqliteTaskEventStoreOptions {
  readonly storage?: SqliteStorageBackendConfig;
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly writerFence?: () => DaemonWriterFence;
  readonly activationPreflight?: (input: { readonly rootInput: HarnessLayoutInput; readonly repoId: string }) => void;
  readonly withAppendFence?: <T>(operation: () => T) => T;
  readonly onMaterializationHealthChange?: (health: MaterializationHealth) => void;
  readonly mutable?: boolean;
  readonly generation?: 1 | 2 | 3;
  readonly killpoint?: (
    point: import("@harness-anything/kernel/internal/ports/task-event-store.ts").EventPublicationKillpoint,
  ) => void;
  readonly onOpenProgress?: (progress: { readonly applied: number; readonly total: number }) => void;
}

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
  let resolvedLedger: ReturnType<typeof resolveLedgerGitLayout> | null = null;
  const ledger = () => (resolvedLedger ??= resolveLedgerGitLayout(input));
  // The layout every append resolves for its worktree baseline is kept so receipt prose reuses the
  // write's own view of the workspace; it refreshes on each accepted append, matching the append
  // path's own freshness rather than caching settings across writes.
  let latestAppendLayout: ReturnType<typeof resolveHarnessLayout> | null = null;
  const authoredRef = () => {
    const current = ledger(),
      branch = options.authoredBranch ?? localGitObjectRefStore.currentBranch(current.rootDir);
    if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
    return `refs/heads/${branch}`;
  };
  // Null until a settlement pass completes in this process; until then the worktree's manifest says where it stands.
  let settledWorktreeRevision: number | null = null,
    closed = false,
    follower = pendingFollower("Git follower has not published this ledger cut"),
    certified: { readonly commit: string; readonly revision: number } | null = null;

  const head = (): EventHead | null => sqlite.headIdentity();
  const cut = () => canonicalLedgerCut(options.repoId, head());
  const readContent = (sha256: string) => sqlite.readContentObject(sha256);
  const readDispatchLifecycleMigrationEvents = (): readonly CanonicalEventV1[] | undefined => {
    const projectionPath = resolveHarnessLayout(input).taskProjectionPath;
    if (!localRuntimeStateFileSystem.exists(projectionPath)) return undefined;
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      const projectionHead = Number(
        db.prepare("SELECT COALESCE(watermark, 0) AS revision FROM projection_meta WHERE singleton = 1").get()
          ?.revision ?? -1,
      );
      // A stale or partially built cache cannot prove which groups are unfinished. Returning no
      // candidates would silently lose old groups, so let the attach caller use its canonical
      // fallback unless this cache is a complete cut.
      if (projectionHead !== sqlite.revision()) return undefined;
      const candidateSessions = legacyDispatchLifecycleMigrationSessions(db);
      if (candidateSessions.length === 0) return [];
      const groupIds = db
        .prepare(
          "SELECT DISTINCT COALESCE(json_extract(event_json, '$.payload.attemptGroupId'), " +
            "json_extract(event_json, '$.payload.dispatchId')) AS attempt_group_id " +
            "FROM event_index WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' " +
            "AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested' " +
            `AND json_extract(event_json, '$.payload.runtimeSessionId') IN (${candidateSessions.map(() => "?").join(",")})`,
        )
        .all(...candidateSessions)
        .map((row) => row.attempt_group_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (groupIds.length === 0) return [];
      const events = new Map<number, CanonicalEventV1>();
      for (const groupId of groupIds) {
        const rows = db
          .prepare(
            "SELECT workspace_revision, event_json FROM event_index WHERE " +
              "json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND " +
              "json_extract(event_json, '$.type') = 'runtime_dispatch_requested' AND " +
              "COALESCE(json_extract(event_json, '$.payload.attemptGroupId'), " +
              "json_extract(event_json, '$.payload.dispatchId')) = ? ORDER BY workspace_revision",
          )
          .all(groupId);
        for (const row of rows) events.set(Number(row.workspace_revision), JSON.parse(String(row.event_json)));
      }
      const requests = [...events.values()];
      const sessionIds = requests
        .map((event) => (event.type === "runtime_dispatch_requested" ? event.payload.runtimeSessionId : null))
        .filter((value): value is string => typeof value === "string");
      for (const sessionId of sessionIds) {
        const rows = db
          .prepare(
            "SELECT workspace_revision, event_json FROM event_index WHERE " +
              "json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND " +
              "json_extract(event_json, '$.payload.runtimeSessionId') = ? AND " +
              "json_extract(event_json, '$.type') IN ('runtime_session_started', 'runtime_session_exited', 'runtime_session_outcome_observed') " +
              "ORDER BY workspace_revision",
          )
          .all(sessionId);
        for (const row of rows) events.set(Number(row.workspace_revision), JSON.parse(String(row.event_json)));
      }
      return [...events.entries()].sort(([left], [right]) => left - right).map(([, event]) => event);
    } finally {
      db.close();
    }
  };
  const acceptedWorktree = new Map<string, { fingerprint: string; preserve: boolean }>(),
    // Each target a settlement left alone, with the bytes it would have settled there.
    worktreeConflicts = new Map<string, string>();
  const append = (bundle: CanonicalWriteBundle): CanonicalEventAppendReceipt => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    validateCanonicalWriteBundle(bundle);
    options.killpoint?.("before_event_write");
    const members = [...(bundle.preceding ?? []), bundle],
      appended = members.map((member) => member.event),
      blobs = members.flatMap((member) => member.blobs),
      revisionBeforeAcceptance = sqlite.revision(),
      appendLayout = resolveHarnessLayout(input),
      authoredRoot = appendLayout.authoredRoot,
      acceptedBaseline = new Map<string, { fingerprint: string; preserve: boolean }>();
    latestAppendLayout = appendLayout;
    assertAuthorizedReplacements(
      {
        eventExists: (opId) => sqlite.event(opId) !== null,
        documentHead: sqlite.documentHead,
        readContentObject: sqlite.readContentObject,
        local: (target) => {
          const node = localGitWorktreeSettlement.readNode(`${authoredRoot}/${target}`);
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
        if (!task && !prose && !settings) continue;
        const node = localGitWorktreeSettlement.readNode(`${authoredRoot}/${claim.path}`);
        if (!node || node.mode !== "100644") continue;
        const matches =
          task ||
          (node.body.includes("\r\n") ? sha256Text(node.body.replace(/\r\n/gu, "\n")) : node.sha256) === claim.sha256 ||
          // A Settings write may declare the live authored bytes as its base; settling that base
          // to the event's claim is the write the event was built for, not a concurrent edit.
          (settings && node.sha256 === event.payload.baseDocumentSha256);
        if (matches) acceptedBaseline.set(claim.path, { fingerprint: worktreeFingerprint(node), preserve: task });
      }
    }
    const fence = options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 },
      accept = () =>
        sqlite.appendValidatedBundle({
          fence: { repoId: fence.repoId, holder: fence.holderId, epoch: fence.epoch },
          events: appended,
          blobs,
          beforeOutcome: () => options.killpoint?.("after_event_write"),
        });
    if (options.withAppendFence) options.withAppendFence(accept);
    else accept();
    if (sqlite.revision() > revisionBeforeAcceptance)
      for (const [logical, baseline] of acceptedBaseline) acceptedWorktree.set(logical, baseline);
    try {
      options.killpoint?.("after_store_commit");
      // Acceptance advances the ledger head, not the already verified follower prefix.
      void publisher.request();
      options.killpoint?.("before_response_write");
      const receipt: CanonicalEventAppendReceipt = {
        status: "applied",
        event: bundle.event,
        revision: bundle.event.workspaceRevision,
        commitSha:
          follower.git.status === "verified" &&
          follower.git.cut !== null &&
          follower.git.cut.revision >= bundle.event.workspaceRevision &&
          follower.git.commitSha
            ? ledgerCommitSha(options.repoId, follower.git.commitSha)
            : null,
        cut: canonicalEventCutFromHead(options.repoId, sqlite.eventIdentity(bundle.event.opId)!),
        metrics: { gitProcesses: 0, nodeSyncs: 0, changedPaths: [] },
      };
      options.killpoint?.("after_response_write");
      return receipt;
    } catch (error) {
      // Only this invocation's committed transaction can turn response loss into indeterminate publication.
      throw Object.assign(
        new TaskEventStoreError("publication_indeterminate", error instanceof Error ? error.message : String(error)),
        { opId: bundle.event.opId, cause: error },
      );
    }
  };

  /** Returns the targets left alone: bytes that are neither baseline nor settled are a concurrent edit, and win. */
  const settleFollowerWorktree = (
    layout: ReturnType<typeof resolveHarnessLayout>,
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    files: readonly (PublicationWrite | PublicationDelete)[],
    baseline: ReadonlyMap<string, string>,
    commit: string,
    directories: FollowerDirectorySettlement,
    restoreMissing: boolean,
  ): { readonly settlements: MaterializationReceipt["settlements"]; readonly conflicts: readonly string[] } => {
    const plan = planFollowerSettlement(acceptedWorktree, currentLedger, files, baseline, restoreMissing),
      manifest = ledgerGitPath(currentLedger, "events/segments/manifest.json"),
      isManifest = (file: PublicationWrite | PublicationDelete) => "target" in file && file.target === manifest,
      conflicts: string[] = [...plan.conflicts],
      first = settleWorktree(
        layout,
        currentLedger.rootDir,
        plan.eligible.filter((file) => !isManifest(file)),
        plan.permitted,
        options.killpoint,
        plan.preserve,
        commit,
        options.withAppendFence,
      );
    conflicts.push(...first.conflicts);
    // Creating an owned directory is additive and idempotent, so it runs even when a concurrent edit made part
    // of this settlement ineligible: a partial pass must not be the reason a directory stays missing. Retiring
    // one is equally safe under a partial pass, because a directory whose files have not been removed yet is
    // still occupied and is therefore left standing.
    settleWorktreeDirectories(currentLedger.rootDir, directories, options.withAppendFence);
    // A restart resumes from this manifest, so it lands only after everything it vouches for.
    const second = settleWorktree(
      layout,
      currentLedger.rootDir,
      plan.eligible.filter(isManifest),
      plan.permitted,
      options.killpoint,
      undefined,
      undefined,
      options.withAppendFence,
    );
    conflicts.push(...second.conflicts);
    acceptedWorktree.clear();
    const skipped = new Set(conflicts),
      settledTargets = new Set(
        plan.eligible.flatMap((file) => {
          const target = "target" in file ? file.target : file.delete;
          return skipped.has(target) ? [] : [target];
        }),
      ),
      copies = new Map(first.preserved.map((preserved) => [preserved.target, preserved.copy]));
    return {
      settlements: settlementRows(currentLedger, plan, settledTargets, copies),
      conflicts,
    };
  };

  /**
   * Publishes only what SQLite accepted since the followers last settled: Git on top of its certified parent, the
   * worktree against what it last held. `restoreMissing` (materialize) settles the whole closure instead; `preview`
   * runs that same whole-closure read and reports the plan without writing anything.
   */
  const publishFollower = (restoreMissing = false, preview = false): MaterializationReceipt => {
    const accepted = cut(),
      currentLedger = ledger(),
      currentRef = authoredRef(),
      parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, currentRef);
    if (accepted.revision === 0) {
      if (!preview) follower = pendingFollower("No accepted ledger cut exists to publish");
      return {
        status: preview ? "planned" : "visible",
        commitSha: ledgerCommitSha(options.repoId, parent),
        settlements: [],
        conflicts: [],
      };
    }
    const verifiedRevision =
        certified?.commit === parent ? certified.revision : certifiedFollowerRevision(currentLedger, parent, sqlite),
      worktreeRevision = settledWorktreeRevision ?? physicalWorktreeRevision(currentLedger, sqlite),
      // A generation converted before the index followed Git can still index pre-SQLite paths; an open repairs it.
      legacy = settledWorktreeRevision === null ? legacyRetirements(currentLedger, null) : [],
      from = restoreMissing ? 0 : Math.min(verifiedRevision, worktreeRevision);
    certified = { commit: parent, revision: verifiedRevision };
    if (from === accepted.revision && legacy.length === 0) {
      settledWorktreeRevision = accepted.revision;
      follower = {
        git: { status: "verified", cut: accepted, commitSha: parent },
        worktree:
          follower.worktree.cut?.revision === accepted.revision
            ? follower.worktree
            : { status: "verified", cut: accepted, commitSha: parent, conflicts: [] },
      };
      return {
        status: "visible",
        commitSha: ledgerCommitSha(options.repoId, parent),
        settlements: [],
        conflicts: [],
      };
    }
    const closure = closureFiles(materializeContext(), accepted, from),
      files = [...closure.files, ...legacy],
      baseline = new Map(captureGitBaseline(currentLedger.rootDir, parent, files));
    if (restoreMissing || worktreeRevision !== verifiedRevision) {
      // The worktree last settled at another cut than Git's parent, so it may still hold what the ledger held then.
      const held = new Map([
        ...ledgerWorktreeBaseline(currentLedger, sqlite, worktreeRevision, files),
        ...recoverGeneratedWorktreeBaseline(currentLedger, closure.events),
      ]);
      for (const [target, previous] of held)
        if (
          worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) !==
          baseline.get(target)
        )
          baseline.set(target, previous);
    }
    if (preview) {
      // The same whole-closure classification the settling pass below applies, reported without writing anything.
      const plan = planFollowerSettlement(acceptedWorktree, currentLedger, files, baseline, restoreMissing);
      return {
        status: "planned",
        commitSha: ledgerCommitSha(options.repoId, parent),
        settlements: settlementRows(
          currentLedger,
          plan,
          new Set(plan.eligible.map((file) => ("target" in file ? file.target : file.delete))),
          new Map(),
        ),
        conflicts: [...new Set([...plan.conflicts, ...worktreeConflicts.keys()])]
          .sort()
          .map((target) => ledgerAuthoredPath(currentLedger, target)),
      };
    }
    const commit = publishFollowerCut(currentLedger.rootDir, currentRef, parent, verifiedRevision, accepted, files, {
      killpoint: options.killpoint,
      withFence: options.withAppendFence,
    });
    certified = { commit, revision: accepted.revision };
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      worktree: pendingFollower("worktree settlement has not verified the Git cut").worktree,
    };
    localGitWorktreeSettlement.index(currentLedger.rootDir, files, false, options.withAppendFence);
    const settled = settleFollowerWorktree(
      latestAppendLayout ?? resolveHarnessLayout(input),
      currentLedger,
      files,
      baseline,
      commit,
      followerDirectories(currentLedger, closure.events),
      restoreMissing,
    );
    const skipped = new Set(settled.conflicts);
    // A skipped target is never retried on its own: it stays reported until settled or its settled bytes appear.
    for (const [target, settledBytes] of worktreeConflicts)
      if (
        worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) === settledBytes
      )
        worktreeConflicts.delete(target);
    for (const file of files) {
      const target = "target" in file ? file.target : file.delete;
      if (skipped.has(target)) worktreeConflicts.set(target, settledFingerprint(file));
      else worktreeConflicts.delete(target);
    }
    settledWorktreeRevision = accepted.revision;
    const conflicts = [...worktreeConflicts.keys()].sort();
    follower = {
      git: follower.git,
      worktree:
        conflicts.length === 0
          ? { status: "verified", cut: accepted, commitSha: commit, conflicts }
          : {
              status: "pending",
              cut: accepted,
              commitSha: commit,
              reason: "authored worktree has concurrent edits",
              conflicts,
            },
    };
    return {
      status: "visible",
      commitSha: ledgerCommitSha(options.repoId, commit),
      settlements: settled.settlements,
      conflicts: conflicts.map((target) => ledgerAuthoredPath(currentLedger, target)),
    };
  };

  const publisher = createDurableFollowerPublisher({
    withFence: options.withAppendFence,
    publish: (request) =>
      request?.paths && !request.preview
        ? restoreRequestedDocuments(materializeContext(), request.paths)
        : publishFollower(request !== undefined, request?.preview),
    revision: sqlite.revision,
    checkpoint: () => follower.git.cut?.revision ?? 0,
    onHealthChange: options.onMaterializationHealthChange,
    onFailure: (reason) => {
      const pending = pendingFollower(reason);
      follower = {
        git:
          follower.git.status === "verified" && follower.git.cut?.revision === sqlite.revision()
            ? follower.git
            : pending.git,
        worktree: pending.worktree,
      };
    },
  });

  if (options.mutable !== false) void publisher.request();

  // The operator-facing materialize requests live in their own module but settle through this store's live state.
  const materializeContext = () => ({
    repoId: options.repoId,
    killpoint: options.killpoint,
    withFence: options.withAppendFence,
    cut,
    ledger,
    authoredRef,
    sqlite,
    readContent,
    acceptedWorktree,
    worktreeConflicts,
    layout: () => resolveHarnessLayout(input),
  });
  const appendRejection: CanonicalEventStore["appendRejection"] = (value) => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
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

  return {
    canonicalRef: `sqlite:generation-${sqlite.metadata().generation}`,
    read: () => ({ schema: "canonical-event-stream/v1", revision: sqlite.revision(), events: sqlite.events() }),
    readHead: head,
    currentCut: cut,
    currentCommit: () =>
      ledgerCommitSha(options.repoId, localGitObjectRefStore.resolveCommit(ledger().rootDir, authoredRef())),
    // Migration import asks for the cut of a prepared event before it commits, so derive it from the event.
    publication: (event) => ({ commitSha: null, cut: canonicalEventCut(options.repoId, event) }),
    appendRejection,
    readEvent: sqlite.event,
    readEventById: sqlite.eventById,
    readEventAtRevision: sqlite.eventAtRevision,
    queryEvents: sqlite.queryEvents,
    readDispatchLifecycleMigrationEvents,
    readEntityDeclarations: sqlite.readEntityDeclarations,
    readTaskEvent: (opId) => {
      const event = sqlite.event(opId);
      return event && isTaskEvent(event) ? event : null;
    },
    readBatch: (cursor, maxItems) => sqliteEventBatch(sqlite, cursor, maxItems, readContent),
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
    materialize: (request?: MaterializationRequest) => publisher.publish(request ?? {}),
    materializationHealth: publisher.health,
    drain: async () => {
      await publisher.drain();
      if (!closed) sqlite.close();
      closed = true;
    },
    settlePendingMaterialization: publisher.request,
    readCommandOutcome: sqlite.readCommandOutcome,
    ledgerMetadata: sqlite.metadata,
    followerStatus: () => follower,
    pruneReplicationLog: (beforeSequence) => {
      if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
      sqlite.pruneReplicationLog(beforeSequence);
    },
  };
}

function pendingFollower(reason: string): ReturnType<CanonicalEventStore["followerStatus"]> {
  return {
    git: { status: "pending", cut: null, commitSha: null, reason },
    worktree: { status: "pending", cut: null, commitSha: null, reason },
  };
}

export function sqliteEventBatch(
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
