import path from "node:path";
import { resolveHarnessLayout, type PublicationWrite } from "@harness-anything/kernel";
import { ledgerCommitSha } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  TaskEventStoreError,
  type CanonicalEventStore,
  type CanonicalFollowerFacet,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { applyCanonicalTree } from "../canonical-tree-materialization.ts";
import type { PgGitFollowerHandle, PgGitFollowerMountContext } from "../postgres/pg-canonical-event-store.ts";
import { readNodeMaterializationDocuments, requireTaskMaterializationMetadata } from "../storage-backend.ts";
import { createDurableFollowerPublisher } from "../store/durable-follower-publisher.ts";
import { ledgerAuthoredPath, ledgerGitPath, resolveLedgerGitLayout } from "../store/ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "../store/local-version-control-system.ts";
import { projectionManagedPath, restoreCanonicalDocumentSelection } from "../store/sqlite-task-event-materialize.ts";
import { certifiedFollowerRevision, followerFilesFromDocumentHeads } from "../store/sqlite-task-event-publication.ts";
import { publishFollowerCut } from "../store/task-event-store-git-refs.ts";

/** Attach host/legacy Git follower and authored worktree materialization to a PG/PGlite canonical store. */
export function attachPgGitFollower(context: PgGitFollowerMountContext): PgGitFollowerHandle {
  const { options, rootInput, reader, head, readContentBlob, writable, checkpointSource } = context;
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
      materializeTree = options.storage.materialize !== false;
    if (options.storage.nodeTaskMaterializationPolicy === "none" && request === undefined) {
      git = { status: "pending", cut, commitSha: null, reason: "Skipped by node policy" };
      worktree = { status: "verified", cut, commitSha: null, conflicts: [] };
      return { status: "visible", commitSha: null, settlements: [], conflicts: [] };
    }
    if (!materializeTree && request)
      throw new TaskEventStoreError("materialization_failed", "Authored tree materialization is disabled");
    if (rootInput === undefined) {
      if (request)
        throw new TaskEventStoreError("materialization_failed", "No authored tree is configured for this repository");
      return { status: "visible", commitSha: null, settlements: [], conflicts: [] };
    }
    const preserveExistingOnly =
      request?.reconcileNodePolicy && options.storage.nodeTaskMaterializationPolicy === "none";
    const requirePreviousPaths = (paths: readonly string[]) => {
      if (preserveExistingOnly) {
        const prior = new Set(paths);
        for (const entryPath of entries.keys()) if (!prior.has(entryPath)) entries.delete(entryPath);
      }
      if (paths.some((entryPath) => entryPath.startsWith("tasks/task_") && entryPath.split("/").length > 2))
        reader.withSession((q) => requireTaskMaterializationMetadata(q, paths));
    };
    const layout = resolveHarnessLayout(rootInput),
      documents =
        materializeTree || options.storage.gitFollower
          ? reader.withSession((q) =>
              readNodeMaterializationDocuments(
                q,
                preserveExistingOnly ? "in_flight" : (options.storage.nodeTaskMaterializationPolicy ?? "include_done"),
                request?.paths,
              ),
            )
          : [],
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
            layout,
            markerPath: path.join(layout.localRoot, "fleet-materialized.json"),
            requirePreviousPaths,
            generation: 3,
            revision: cut.revision,
            entries,
            preview: request?.preview,
            selectedPaths: request?.preview ? undefined : request?.paths,
            acceptedRetired: new Map(context.acceptedRetired()),
            readHistoricalDocument: (logical) =>
              reader.withSession((q) => q.readDocumentHistory?.(logical)?.document ?? null),
            readContent: (logical) => readContentBlob(entries.get(logical)!.sha256),
            withFence: options.withAppendFence,
          })
        : { settlements: [], dirtyPaths: [] };
    if (materializeTree && !request?.preview) {
      context.retainRetiredPaths(request?.paths);
    }
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
        files = followerFilesForNodePolicy({
          ledger,
          documents: preserveExistingOnly ? documents.filter(({ path: docPath }) => entries.has(docPath)) : documents,
          parent,
          readContent: readContentBlob,
          requirePreviousPaths,
          knownDocumentPaths: (paths) => {
            const known = new Set<string>(),
              size = storageReadPolicy.defaultValue.pageSizes.standard;
            for (let offset = 0; offset < paths.length; offset += size)
              for (const docPath of reader.executeCanonical({
                operation: "document-paths",
                paths: paths.slice(offset, offset + size),
              }) as readonly string[])
                known.add(docPath);
            return known;
          },
          cut,
        }),
        commit = publishFollowerCut(ledger.rootDir, authoredRef, parent, checkpoint, cut, files, {
          killpoint: options.killpoint,
          withFence: options.withAppendFence,
        });
      git = { status: "verified", cut, commitSha: commit };
      if (materializeTree) {
        localGitWorktreeSettlement.index(ledger.rootDir, files, false, options.withAppendFence);
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

  const publishFollower: typeof publishConfirmedFollower = (request) => {
    try {
      return publishConfirmedFollower(request);
    } catch (error) {
      if (error instanceof Error && error.message === "sync_replication_unconfirmed") {
        worktree = { ...worktree, status: "pending", reason: error.message };
        git = { ...git, status: "pending", reason: error.message };
      }
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
    currentCommit: () => (git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null),
    followerStatus: () => ({ git, worktree }),
    materialize: publisher.publish,
    materializationHealth: publisher.health,
    settlePendingMaterialization: async (_context: string) => {
      await publisher.request();
    },
    request: () => {
      void publisher.request();
    },
    drain: publisher.drain,
  };
}

/** Build the local Git follower from the policy-filtered projection and retain event retirements for other paths. */
function followerFilesForNodePolicy(input: {
  readonly ledger: ReturnType<typeof resolveLedgerGitLayout>;
  readonly documents: readonly {
    readonly path: string;
    readonly blobSha256: string;
    readonly size: number;
    readonly nodeKind?: "file" | "symbolic-link" | null;
  }[];
  readonly parent: string;
  readonly readContent: (sha256: string) => Uint8Array | null;
  readonly cut: ReturnType<typeof canonicalLedgerCut>;
  readonly requirePreviousPaths?: (paths: readonly string[]) => void;
  readonly knownDocumentPaths: (paths: readonly string[]) => ReadonlySet<string>;
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
    previous = localGitObjectRefStore
      .listTree(input.ledger.rootDir, input.parent, [ledgerGitPath(input.ledger, "").replace(/\/$/u, "") || "."])
      .map(({ target }) => ({ target, logical: ledgerAuthoredPath(input.ledger, target) }));
  const known = input.knownDocumentPaths(previous.map(({ logical }) => logical)),
    owned = previous.filter(({ logical }) => known.has(logical));
  input.requirePreviousPaths?.(owned.map(({ logical }) => logical));
  const staleManaged = owned
    .filter(({ logical }) => projectionManagedPath(logical) && !projectedLogical.has(logical))
    .map(({ target }) => ({ delete: target }));
  return [...projected, ...staleManaged];
}
