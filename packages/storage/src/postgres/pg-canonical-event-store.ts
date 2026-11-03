import { ledgerCommitSha } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import path from "node:path";
import {
  isTaskEvent,
  consumeKnownError,
  resolveHarnessLayout,
  type CanonicalEventV1,
  type CanonicalFollowerFacet,
  type PublicationWrite,
} from "@harness-anything/kernel";
import {
  canonicalEventCut,
  canonicalLedgerCut,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  TaskEventStoreError,
  type CanonicalEventStore,
  type CanonicalCommandOutcome,
  type CanonicalEventAppendReceipt,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { createPgTaskQueryReader } from "../pg/pg-task-query-reader.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import type { PostgresTaskEventStoreOptions } from "../store/task-event-store-factory.ts";
import { applyCanonicalTree } from "../canonical-tree-materialization.ts";
import { resolveLedgerGitLayout } from "../store/ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "../store/local-version-control-system.ts";
import { followerFiles } from "../store/sqlite-task-event-publication.ts";
import { prepareCommit, finalizeRefs } from "../store/task-event-store-git-refs.ts";
import { restoreCanonicalDocumentSelection } from "../store/sqlite-task-event-materialize.ts";

/** The existing PG worker bridge owns whole accepting transactions and the driver pool. */
export function makePgCanonicalEventStore(
  options: PostgresTaskEventStoreOptions,
): CanonicalEventStore & { readonly pruneReplicationLog: (beforeSequence: number) => void } {
  const reader = createPgTaskQueryReader({
      connectionString: options.storage.connectionString,
      requireRuntimeRole: true,
      ...((options.rootInput ?? options.rootDir) === undefined
        ? {}
        : { authoredRoot: resolveHarnessLayout((options.rootInput ?? options.rootDir)!).authoredRoot }),
      repoId: options.repoId,
      scope: resolvePostgresEventStoreScope(options.storage.scope),
    }),
    execute = reader.executeCanonical,
    head: CanonicalEventStore["readHead"] = () =>
      execute({ operation: "head" }) as ReturnType<CanonicalEventStore["readHead"]>,
    readEvents = (afterRevision = 0, limit?: number) =>
      execute({ operation: "events", afterRevision, limit }) as readonly CanonicalEventV1[],
    readContentBlob: CanonicalEventStore["readContentBlob"] = (sha256) =>
      execute({ operation: "content", sha256 }) as Uint8Array | null,
    readContentBlobRange: CanonicalEventStore["readContentBlobRange"] = (sha256, offset, maxBytes) =>
      execute({ operation: "content-range", sha256, offset, maxBytes }) as Uint8Array | null,
    readContentBlobSize: CanonicalEventStore["readContentBlobSize"] = (sha256) =>
      execute({ operation: "content-size", sha256 }) as number | null,
    readEvent: CanonicalEventStore["readEvent"] = (value) =>
      execute({ operation: "event", key: "op_id", value }) as CanonicalEventV1 | null,
    writable = () => {
      if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    },
    fence = () => options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 };
  let worktree: CanonicalFollowerFacet = { status: "pending", cut: null, commitSha: null },
    git: CanonicalFollowerFacet = {
      status: "pending",
      cut: null,
      commitSha: null,
      reason: "Git follower is not configured",
    },
    scheduled: Promise<void> | null = null,
    lastMaterializationError: string | undefined;
  const publishFollower = (
    request?: Parameters<CanonicalEventStore["materialize"]>[0],
  ): ReturnType<CanonicalEventStore["materialize"]> => {
    writable();
    const cut = canonicalLedgerCut(options.repoId, head()),
      rootInput = options.rootInput ?? options.rootDir,
      materializeTree = options.storage.materialize !== false;
    if (!materializeTree && request)
      throw new TaskEventStoreError("materialization_failed", "Authored tree materialization is disabled");
    if (rootInput === undefined) {
      if (request)
        throw new TaskEventStoreError("materialization_failed", "No authored tree is configured for this repository");
      return { status: "visible", commitSha: null, settlements: [], conflicts: [] };
    }
    const layout = resolveHarnessLayout(rootInput),
      documents = materializeTree ? reader.withSession((q) => q.readDocuments("").documents) : [],
      entries = new Map(documents.map((doc) => [doc.path, { sha256: doc.blobSha256 }])),
      restored =
        request?.paths && !request.preview
          ? restoreCanonicalDocumentSelection({
              ledger: { rootDir: layout.authoredRoot, authoredRoot: layout.authoredRoot, authoredPrefix: "" },
              layout,
              headDigest: cut.headDigest,
              paths: request.paths,
              canonical: new Map(
                documents
                  .filter((doc) => request.paths!.includes(doc.path))
                  .map((doc) => [
                    doc.path,
                    { target: doc.path, mode: "100644" as const, body: readContentBlob(doc.blobSha256)! },
                  ]),
              ),
              killpoint: options.killpoint,
            })
          : null,
      result = materializeTree
        ? applyCanonicalTree({
            authoredRoot: layout.authoredRoot,
            markerPath: path.join(layout.localRoot, "fleet-materialized.json"),
            generation: 3,
            revision: cut.revision,
            entries,
            preview: request?.preview,
            selectedPaths: request?.preview ? undefined : request?.paths,
            readContent: (logical) => readContentBlob(entries.get(logical)!.sha256),
          })
        : { settlements: [], dirtyPaths: [] };
    if (request?.preview)
      return {
        status: "planned",
        commitSha: git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null,
        settlements: result.settlements,
        conflicts: result.dirtyPaths,
      };
    const conflicts = [
      ...new Set([
        ...result.dirtyPaths,
        ...(restored?.conflicts ?? []),
        ...(request?.paths ? (worktree.conflicts ?? []).filter((logical) => !request.paths!.includes(logical)) : []),
      ]),
    ];
    worktree = materializeTree
      ? {
          status: conflicts.length === 0 ? "verified" : "pending",
          cut,
          commitSha: null,
          conflicts,
        }
      : { status: "pending", cut: null, commitSha: null, reason: "Authored tree materialization is disabled" };
    const follower = options.storage.gitFollower;
    if (follower && git.cut?.revision !== cut.revision && cut.revision > 0) {
      const ledger = resolveLedgerGitLayout(rootInput),
        authoredRef = `refs/heads/${follower.branch}`,
        parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
        temporaryRef = `refs/ha-pg-outbox/${cut.revision}`,
        files = followerFiles(ledger, readEvents(), readContentBlob, cut, 3),
        commit = prepareCommit(
          ledger.rootDir,
          temporaryRef,
          parent,
          files,
          `outbox-${cut.revision}`,
          new Date().toISOString(),
        );
      finalizeRefs(ledger.rootDir, authoredRef, commit, parent, temporaryRef);
      if (materializeTree) {
        localGitWorktreeSettlement.index(ledger.rootDir, files);
        // followerFiles puts its generated cut manifest last; authored documents were settled by
        // the common tree owner above, which preserves concurrent edits instead of overwriting them.
        localGitWorktreeSettlement.visible(ledger.rootDir, [files.at(-1)! as PublicationWrite]);
      }
      git = { status: "verified", cut, commitSha: commit };
    }
    return {
      status: "visible",
      commitSha: git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null,
      settlements: restored?.settlements ?? result.settlements,
      conflicts: restored?.conflicts ?? result.dirtyPaths,
    };
  };
  const materializationCheckpoint = () =>
    options.storage.materialize === false
      ? options.storage.gitFollower
        ? (git.cut?.revision ?? 0)
        : (head()?.revision ?? 0)
      : (worktree.cut?.revision ?? 0);
  const materializationHealth = (state: "ok" | "failed", lastError?: string) => ({
    state,
    lastCheckpointRevision: materializationCheckpoint(),
    lastCheckpointAt: null,
    pendingWalEvents: (head()?.revision ?? 0) - materializationCheckpoint(),
    ...(lastError ? { reason: "deterministic_failure" as const, lastError } : {}),
  });
  const follow = (request?: Parameters<CanonicalEventStore["materialize"]>[0]) => {
    const receipt = options.withAppendFence
      ? options.withAppendFence(() => publishFollower(request))
      : publishFollower(request);
    if (request === undefined) {
      lastMaterializationError = undefined;
      options.onMaterializationHealthChange?.(materializationHealth("ok"));
    }
    return receipt;
  };
  // Acceptance and follower publication are separate: this detached consumer always rereads the
  // current PG cut, so its failure cannot turn a committed append into an ambiguous write result.
  const schedule = (): Promise<void> =>
    (scheduled ??= new Promise<void>((resolve) =>
      setImmediate(() => {
        try {
          follow();
        } catch (error) {
          lastMaterializationError = error instanceof Error ? error.message : String(error);
          consumeKnownError(error);
          options.onMaterializationHealthChange?.(materializationHealth("failed", lastMaterializationError));
        } finally {
          scheduled = null;
          resolve();
        }
      }),
    ));
  if (options.mutable !== false) void schedule();
  return {
    canonicalRef: "postgres:canonical",
    read: () => execute({ operation: "stream" }) as ReturnType<CanonicalEventStore["read"]>,
    readHead: head,
    currentCut: () => canonicalLedgerCut(options.repoId, head()),
    currentCommit: () => (git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null),
    publication: (event) => ({ commitSha: null, cut: canonicalEventCut(options.repoId, event) }),
    readEvent,
    readEventAtRevision: (value) => execute({ operation: "event", key: "revision", value }) as CanonicalEventV1 | null,
    readEventById: (value) => execute({ operation: "event", key: "event_id", value }) as CanonicalEventV1 | null,
    queryEvents: (query) => execute({ operation: "events", query }) as readonly CanonicalEventV1[],
    readTaskEvent: (opId) => {
      const event = readEvent(opId);
      return event && isTaskEvent(event) ? event : null;
    },
    readCommandOutcome: (opId) => execute({ operation: "outcome", opId }) as CanonicalCommandOutcome | null,
    ledgerMetadata: () => ({ repoId: options.repoId, generation: 3, revision: head()?.revision ?? 0 }),
    followerStatus: () => ({ git, worktree }),
    readBatch: (cursor, maxItems) =>
      execute({ operation: "batch", cursor, maxItems }) as ReturnType<CanonicalEventStore["readBatch"]>,
    readContentBlob,
    readContentBlobRange,
    readContentBlobSize,
    layout: () => "sharded-sha256-2/v1",
    append: (bundle) => {
      writable();
      const receipt = execute({
        operation: "append",
        bundle,
        expectedRevision: bundle.preceding?.[0]?.event.workspaceRevision
          ? bundle.preceding[0].event.workspaceRevision - 1
          : bundle.event.workspaceRevision - 1,
        writerFence: fence(),
      }) as CanonicalEventAppendReceipt;
      void schedule();
      return receipt;
    },
    appendRejection: (rejection) => {
      writable();
      return execute({
        operation: "reject",
        rejection,
        expectedRevision: head()?.revision ?? 0,
        writerFence: fence(),
      }) as CanonicalCommandOutcome;
    },
    materialize: follow,
    materializationHealth: () => {
      const revision = head()?.revision ?? 0,
        checkpoint = materializationCheckpoint();
      return {
        state: lastMaterializationError ? "failed" : scheduled ? "retrying" : "ok",
        lastCheckpointRevision: checkpoint,
        lastCheckpointAt: null,
        pendingWalEvents: revision - checkpoint,
        ...(lastMaterializationError ? { reason: "deterministic_failure", lastError: lastMaterializationError } : {}),
      };
    },
    settlePendingMaterialization: async () => {
      await scheduled;
      follow();
    },
    drain: async () => {
      await scheduled;
      reader.close();
    },
    pruneReplicationLog: (beforeSequence) => {
      writable();
      execute({ operation: "prune", beforeSequence, writerFence: fence() });
    },
  };
}
