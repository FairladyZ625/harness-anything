import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  ledgerCommitSha,
  serializePersistedCanonicalEvent,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import path from "node:path";
import {
  isTaskEvent,
  resolveHarnessLayout,
  type CanonicalEventV1,
  type CanonicalFollowerFacet,
  type PublicationWrite,
} from "@harness-anything/kernel";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
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
import { createSqlTaskQueryReader } from "../pg/sql-task-query-reader.ts";
import { validateContentRange } from "../content-blob-range.ts";
import type { PostgresTaskEventStoreOptions, PGliteTaskEventStoreOptions } from "../store/task-event-store-factory.ts";
import { applyCanonicalTree } from "../canonical-tree-materialization.ts";
import { resolveLedgerGitLayout } from "../store/ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "../store/local-version-control-system.ts";
import {
  certifiedFollowerRevision,
  followerEventsAfter,
  followerFiles,
  followerFilesFromDocumentHeads,
  physicalWorktreeRevision,
} from "../store/sqlite-task-event-publication.ts";
import { publishFollowerCut } from "../store/task-event-store-git-refs.ts";
import { projectionManagedPath, restoreCanonicalDocumentSelection } from "../store/sqlite-task-event-materialize.ts";
import { createDurableFollowerPublisher } from "../store/durable-follower-publisher.ts";
import { ledgerAuthoredPath, ledgerGitPath } from "../store/ledger-git-layout.ts";
import {
  taskIncludedByNodeMaterializationPolicy,
  type NodeTaskMaterializationPolicy,
} from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";

/**
 * One handle belongs to the single writer. Its synchronous bridge can wait in SyncRep;
 * concurrent reads must open independent product reader handles on another thread.
 * The host retains the writer slot until the underlying response, even after caller detach.
 */
export function makePgCanonicalEventStore(
  options: PostgresTaskEventStoreOptions | PGliteTaskEventStoreOptions,
): CanonicalEventStore & { readonly pruneReplicationLog: (beforeSequence: number) => void } {
  const rootInput = options.rootInput ?? options.rootDir,
    reader = createSqlTaskQueryReader({
      storage: options.storage,
      repoId: options.repoId,
      requireRuntimeRole: true,
      ...(rootInput === undefined ? {} : { authoredRoot: resolveHarnessLayout(rootInput).authoredRoot }),
    }),
    execute = reader.executeCanonical,
    head: CanonicalEventStore["readHead"] = () =>
      execute({ operation: "head" }) as ReturnType<CanonicalEventStore["readHead"]>,
    readEvents = (afterRevision = 0, limit?: number) =>
      execute({ operation: "events", afterRevision, limit }) as readonly CanonicalEventV1[],
    checkpointSource = {
      metadata: () => ({ repoId: options.repoId, generation: 3, revision: head()?.revision ?? 0 }),
      eventIdentityAtRevision: (revision: number) => {
        const event = execute({ operation: "event", key: "revision", value: revision }) as CanonicalEventV1 | null;
        return event
          ? {
              revision: event.workspaceRevision,
              opId: event.opId,
              eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}` as const,
            }
          : null;
      },
    },
    readContentBlob: CanonicalEventStore["readContentBlob"] = (sha256) =>
      execute({ operation: "content", sha256 }) as Uint8Array | null,
    readContentBlobRange: CanonicalEventStore["readContentBlobRange"] = (sha256, offset, maxBytes) => {
      validateContentRange(offset, maxBytes);
      return execute({ operation: "content-range", sha256, offset, maxBytes }) as Uint8Array | null;
    },
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
    };
  const publishConfirmedFollower = (
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
      materialization = materializeTree
        ? reader.withSession((q) => {
            const allDocuments: ReturnType<typeof q.readDocuments>["documents"][number][] = [];
            let afterPath: string | undefined;
            for (;;) {
              const result = q.readDocuments("", {
                limit: storageReadPolicy.defaultValue.pageSizes.standard,
                ...(afterPath === undefined ? {} : { afterPath }),
              });
              allDocuments.push(...result.documents);
              if (result.page!.nextPath === null) break;
              afterPath = result.page!.nextPath;
            }
            const taskIndex = q.readTaskIndex().rows;
            return {
              documents: filterNodeTaskDocuments(
                allDocuments,
                taskIndex,
                q.readTaskRelationsBySources(
                  taskIndex
                    .filter((task) => taskIncludedByNodeMaterializationPolicy("in_flight", task))
                    .map(({ taskId }) => `task/${taskId}`),
                  "depends-on",
                ).rows,
                options.storage.nodeTaskMaterializationPolicy ?? "include_done",
                request?.paths,
              ),
              canonicalPaths: new Set(allDocuments.map(({ path }) => path)),
            };
          })
        : { documents: [], canonicalPaths: new Set<string>() },
      documents = materialization.documents,
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
              withFence: options.withAppendFence,
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
            withFence: options.withAppendFence,
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
    if (follower && cut.revision > 0) {
      const ledger = resolveLedgerGitLayout(rootInput),
        authoredRef = `refs/heads/${follower.branch}`,
        parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
        checkpoint =
          git.commitSha === parent && git.cut
            ? git.cut.revision
            : certifiedFollowerRevision(ledger, parent, checkpointSource),
        events = followerEventsAfter(
          readEvents,
          materializeTree ? Math.min(checkpoint, physicalWorktreeRevision(ledger, checkpointSource)) : checkpoint,
          cut.revision,
        ),
        files = followerFilesForNodePolicy({
          ledger,
          events,
          documents,
          parent,
          readContent: readContentBlob,
          cut,
          canonicalPaths: materialization.canonicalPaths,
        }),
        commit = publishFollowerCut(ledger.rootDir, authoredRef, parent, checkpoint, cut, files, {
          killpoint: options.killpoint,
          withFence: options.withAppendFence,
        });
      git = { status: "verified", cut, commitSha: commit };
      if (materializeTree) {
        localGitWorktreeSettlement.index(ledger.rootDir, files, false, options.withAppendFence);
        // followerFiles puts its generated cut manifest last; authored documents were settled by
        // the common tree owner above, which preserves concurrent edits instead of overwriting them.
        localGitWorktreeSettlement.visible(ledger.rootDir, [files.at(-1)! as PublicationWrite], {
          withFence: options.withAppendFence,
        });
      }
    }
    return {
      status: "visible",
      commitSha: git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null,
      settlements: restored?.settlements ?? result.settlements,
      conflicts: restored?.conflicts ?? result.dirtyPaths,
    };
  };
  // Acceptance and follower publication are separate: this detached consumer always rereads the
  // current PG cut, so its failure cannot turn a committed append into an ambiguous write result.
  const publishFollower: typeof publishConfirmedFollower = (request) => {
    try {
      return publishConfirmedFollower(request);
    } catch (error) {
      if (error instanceof Error && error.message === "sync_replication_unconfirmed") {
        worktree = { ...worktree, status: "pending", reason: error.message };
        git = { ...git, status: "pending", reason: error.message };
      }
      // The existing durable publisher owns retry/backoff; no tree or ref was mutated before the read cut.
      throw error;
    }
  };
  const publisher = createDurableFollowerPublisher({
    publish: publishFollower,
    withFence: options.withAppendFence,
    revision: () => head()?.revision ?? 0,
    checkpoint: () =>
      Math.min(
        options.storage.materialize === false ? Infinity : (worktree.cut?.revision ?? 0),
        options.storage.gitFollower ? (git.cut?.revision ?? 0) : (head()?.revision ?? 0),
      ),
    onHealthChange: options.onMaterializationHealthChange,
  });
  if (options.mutable !== false) void publisher.request();
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
    readEntityDeclarations: (query) =>
      execute({ operation: "entity-declarations", query }) as ReturnType<
        NonNullable<CanonicalEventStore["readEntityDeclarations"]>
      >,
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
      void publisher.request();
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
    materialize: publisher.publish,
    materializationHealth: publisher.health,
    settlePendingMaterialization: publisher.request,
    drain: async () => {
      await publisher.drain();
      reader.close();
    },
    pruneReplicationLog: (beforeSequence) => {
      writable();
      execute({ operation: "prune", beforeSequence, writerFence: fence() });
    },
  };
}

function filterNodeTaskDocuments<T extends { readonly path: string }>(
  documents: readonly T[],
  tasks: readonly {
    readonly taskId: string;
    readonly packagePath: string | null;
    readonly status: string;
    readonly packageDisposition: string | null;
  }[],
  dependencies: readonly { readonly targetRef: string; readonly state: string }[],
  policy: NodeTaskMaterializationPolicy,
  forcedPaths: readonly string[] = [],
): readonly T[] {
  const byPackage = new Map(tasks.flatMap((task) => (task.packagePath ? [[task.packagePath, task] as const] : []))),
    included = new Set(
      tasks.filter((task) => taskIncludedByNodeMaterializationPolicy(policy, task)).map((task) => task.taskId),
    ),
    dependencyTargets = new Set(
      dependencies
        .filter((edge) => edge.state === "active")
        .flatMap((edge) => /^task\/([^/]+)$/u.exec(edge.targetRef)?.[1] ?? []),
    );
  return documents.filter((document) => {
    if (forcedPaths.includes(document.path)) return true;
    if (policy === "none" && "mediaType" in document && document.mediaType === "text/markdown") return false;
    const slash = document.path.indexOf("/", "tasks/".length),
      packagePath = slash < 0 ? document.path : document.path.slice(0, slash),
      task = byPackage.get(packagePath);
    if (!task) return true;
    if (included.has(task.taskId)) return true;
    if (!dependencyTargets.has(task.taskId)) return false;
    return ["INDEX.md", "task_plan.md", "task-contract.json"].includes(document.path.slice(packagePath.length + 1));
  });
}

/** Build the local Git follower from the policy-filtered projection and retain event retirements for other paths. */
function followerFilesForNodePolicy(input: {
  readonly ledger: ReturnType<typeof resolveLedgerGitLayout>;
  readonly events: Iterable<CanonicalEventV1>;
  readonly documents: readonly {
    readonly path: string;
    readonly blobSha256: string;
    readonly size: number;
    readonly nodeKind?: "file" | "symbolic-link" | null;
  }[];
  readonly parent: string;
  readonly readContent: (sha256: string) => Uint8Array | null;
  readonly cut: ReturnType<typeof canonicalLedgerCut>;
  readonly canonicalPaths: ReadonlySet<string>;
}): readonly (PublicationWrite | { readonly delete: string })[] {
  const projected = followerFilesFromDocumentHeads(
      input.ledger,
      input.documents.map((document) => ({
        path: document.path,
        sha256: document.blobSha256,
        size: document.size,
        nodeKind: document.nodeKind ?? "file",
      })),
      input.readContent,
      input.cut,
      3,
    ),
    projectedLogical = new Set(input.documents.map(({ path: documentPath }) => documentPath)),
    managed = (logical: string) => projectionManagedPath(logical),
    eventFiles = followerFiles(input.ledger, input.events, input.readContent, input.cut, 3).filter((file) => {
      const target = "target" in file ? file.target : file.delete,
        logical = ledgerAuthoredPath(input.ledger, target);
      return (
        target !== ledgerGitPath(input.ledger, "events/segments/manifest.json") &&
        !managed(logical) &&
        !("target" in file && projectedLogical.has(logical))
      );
    }),
    staleManaged = localGitObjectRefStore
      .listTree(
        input.ledger.rootDir,
        input.parent,
        [...input.canonicalPaths].map((path) => ledgerGitPath(input.ledger, path)),
      )
      .map(({ target }) => ({ target, logical: ledgerAuthoredPath(input.ledger, target) }))
      .filter(({ logical }) => input.canonicalPaths.has(logical) && managed(logical) && !projectedLogical.has(logical))
      .map(({ target }) => ({ delete: target }));
  return [...eventFiles, ...projected, ...staleManaged];
}
