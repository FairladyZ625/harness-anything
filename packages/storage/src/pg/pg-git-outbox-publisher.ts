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
import {
  alignFollowerIndex,
  alignFollowerIndexAsync,
  localGitObjectRefStore,
  localGitObjectRefStoreAsync,
  localGitWorktreeSettlement,
} from "../store/local-version-control-system.ts";
import type { FollowerIndexCut } from "../store/git-follower-index.ts";
import { projectionManagedPath, restoreCanonicalDocumentSelection } from "../store/sqlite-task-event-materialize.ts";
import {
  certifiedFollowerRevisionFromManifest,
  followerFilesFromDocumentHeads,
  FOLLOWER_MANIFEST_PATH,
} from "../store/sqlite-task-event-publication.ts";
import {
  finalizeRefs,
  finalizeRefsAsync,
  publishFollowerCut,
  publishFollowerCutAsync,
} from "../store/task-event-store-git-refs.ts";

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

  const prepareConfirmedFollower = (request?: Parameters<CanonicalEventStore["materialize"]>[0]) => {
    writable();
    const cut = canonicalLedgerCut(options.repoId, head()),
      materializeTree = options.storage.materialize !== false;
    if (options.storage.nodeTaskMaterializationPolicy === "none" && request === undefined) {
      git = { status: "pending", cut, commitSha: null, reason: "Skipped by node policy" };
      worktree = { status: "verified", cut, commitSha: null, conflicts: [] };
      return {
        done: { status: "visible", commitSha: null, settlements: [], conflicts: [] } as ReturnType<
          CanonicalEventStore["materialize"]
        >,
      };
    }
    if (!materializeTree && request)
      throw new TaskEventStoreError("materialization_failed", "Authored tree materialization is disabled");
    if (rootInput === undefined) {
      if (request)
        throw new TaskEventStoreError("materialization_failed", "No authored tree is configured for this repository");
      return {
        done: { status: "visible", commitSha: null, settlements: [], conflicts: [] } as ReturnType<
          CanonicalEventStore["materialize"]
        >,
      };
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
              withFence: options.withFollowerFence,
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
            withFence: options.withFollowerFence,
          })
        : { settlements: [], dirtyPaths: [] };
    if (materializeTree && !request?.preview) {
      context.retainRetiredPaths(request?.paths);
    }
    if (request?.preview)
      return {
        done: {
          status: "planned",
          commitSha: git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null,
          settlements: result.settlements,
          conflicts: result.dirtyPaths,
        } as ReturnType<CanonicalEventStore["materialize"]>,
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
    return {
      cut,
      materializeTree,
      follower: options.storage.gitFollower,
      documents: preserveExistingOnly ? documents.filter(({ path: docPath }) => entries.has(docPath)) : documents,
      requirePreviousPaths,
      settlements: restored?.settlements ?? result.settlements,
      conflicts: restored?.conflicts ?? result.dirtyPaths,
    };
  };

  const knownDocumentPaths = (paths: readonly string[]) => {
    const known = new Set<string>(),
      size = storageReadPolicy.defaultValue.pageSizes.standard;
    for (let offset = 0; offset < paths.length; offset += size)
      for (const docPath of reader.executeCanonical({
        operation: "document-paths",
        paths: paths.slice(offset, offset + size),
      }) as readonly string[])
        known.add(docPath);
    return known;
  };

  const buildPgReceipt = (
    settlements: ReturnType<CanonicalEventStore["materialize"]>["settlements"],
    conflicts: readonly string[],
  ): ReturnType<CanonicalEventStore["materialize"]> => ({
    status: "visible",
    commitSha: git.commitSha ? ledgerCommitSha(options.repoId, git.commitSha) : null,
    settlements,
    conflicts,
  });

  const finalizePgWorktreeManifest = (
    ledger: ReturnType<typeof resolveLedgerGitLayout>,
    commit: string,
    cut: ReturnType<typeof canonicalLedgerCut>,
    files: readonly (PublicationWrite | { readonly delete: string })[],
    materializeTree: boolean,
  ) => {
    git = { status: "verified", cut, commitSha: commit };
    if (materializeTree)
      localGitWorktreeSettlement.visible(ledger.rootDir, [files.at(-1)! as PublicationWrite], {
        withFence: options.withFollowerFence,
      });
  };

  const indexCut = (
    ledger: ReturnType<typeof resolveLedgerGitLayout>,
    authoredRef: string,
    parent: string,
    commit: string,
    previous: string | null,
    files: readonly (PublicationWrite | { readonly delete: string })[],
  ): FollowerIndexCut => ({
    repoRoot: ledger.rootDir,
    authoredRef,
    authoredPrefix: ledger.authoredPrefix,
    head: commit,
    previous,
    ...(commit === parent ? { visibility: files } : {}),
    ...(git.commitSha === null
      ? {
          ownedDocuments: (targets) =>
            new Set(
              [...knownDocumentPaths(targets.map((target) => ledgerAuthoredPath(ledger, target)))].map((logical) =>
                ledgerGitPath(ledger, logical),
              ),
            ),
        }
      : {}),
  });

  const publishConfirmedFollower = (
    request?: Parameters<CanonicalEventStore["materialize"]>[0],
  ): ReturnType<CanonicalEventStore["materialize"]> => {
    const prepared = prepareConfirmedFollower(request);
    if ("done" in prepared) return prepared.done!;
    if (prepared.follower && prepared.cut.revision > 0 && rootInput !== undefined) {
      const ledger = resolveLedgerGitLayout(rootInput),
        authoredRef = `refs/heads/${prepared.follower.branch}`,
        parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
        checkpoint =
          git.commitSha === parent && git.cut
            ? git.cut.revision
            : certifiedFollowerRevisionFromManifest(
                localGitObjectRefStore.readPath(ledger.rootDir, parent, ledgerGitPath(ledger, FOLLOWER_MANIFEST_PATH)),
                checkpointSource,
              ),
        previousTree = localGitObjectRefStore
          .listTree(ledger.rootDir, parent, [ledgerGitPath(ledger, "").replace(/\/$/u, "") || "."])
          .map(({ target }) => ({ target, logical: ledgerAuthoredPath(ledger, target) })),
        files = followerFilesFromTree({
          ledger,
          documents: prepared.documents,
          previous: previousTree,
          readContent: readContentBlob,
          requirePreviousPaths: prepared.requirePreviousPaths,
          knownDocumentPaths,
          cut: prepared.cut,
        }),
        commit = publishFollowerCut(ledger.rootDir, authoredRef, parent, checkpoint, prepared.cut, files, {
          killpoint: options.killpoint,
          withFence: options.withFollowerFence,
        });
      if (prepared.materializeTree) {
        const previous =
          commit !== parent
            ? parent
            : git.commitSha !== null &&
                git.commitSha !== commit &&
                localGitObjectRefStore.hasCommit(ledger.rootDir, git.commitSha)
              ? git.commitSha
              : null;
        alignFollowerIndex(indexCut(ledger, authoredRef, parent, commit, previous, files), options.withFollowerFence);
      }
      finalizePgWorktreeManifest(ledger, commit, prepared.cut, files, prepared.materializeTree);
    }
    return buildPgReceipt(prepared.settlements, prepared.conflicts);
  };

  const runFinalizeRefsAsync = async (refUpdate: {
    readonly repoRoot: string;
    readonly authoredRef: string;
    readonly commit: string;
    readonly previous: string;
    readonly temporaryRef: string;
  }): Promise<void> => {
    if (options.withFollowerFenceAsync) {
      await options.withFollowerFenceAsync(() =>
        finalizeRefsAsync(
          refUpdate.repoRoot,
          refUpdate.authoredRef,
          refUpdate.commit,
          refUpdate.previous,
          refUpdate.temporaryRef,
        ),
      );
      return;
    }
    if (options.withFollowerFence) {
      options.withFollowerFence(() =>
        finalizeRefs(
          refUpdate.repoRoot,
          refUpdate.authoredRef,
          refUpdate.commit,
          refUpdate.previous,
          refUpdate.temporaryRef,
        ),
      );
      return;
    }
    await finalizeRefsAsync(
      refUpdate.repoRoot,
      refUpdate.authoredRef,
      refUpdate.commit,
      refUpdate.previous,
      refUpdate.temporaryRef,
    );
  };

  const publishConfirmedFollowerAsync = async (
    request?: Parameters<CanonicalEventStore["materialize"]>[0],
  ): Promise<ReturnType<CanonicalEventStore["materialize"]>> => {
    const prepared = prepareConfirmedFollower(request);
    if ("done" in prepared) return prepared.done!;
    if (prepared.follower && prepared.cut.revision > 0 && rootInput !== undefined) {
      const ledger = resolveLedgerGitLayout(rootInput),
        authoredRef = `refs/heads/${prepared.follower.branch}`,
        parent = await localGitObjectRefStoreAsync.resolveCommit(ledger.rootDir, authoredRef),
        checkpoint =
          git.commitSha === parent && git.cut
            ? git.cut.revision
            : certifiedFollowerRevisionFromManifest(
                await localGitObjectRefStoreAsync.readPath(
                  ledger.rootDir,
                  parent,
                  ledgerGitPath(ledger, FOLLOWER_MANIFEST_PATH),
                ),
                checkpointSource,
              ),
        previousTree = (
          await localGitObjectRefStoreAsync.listTree(ledger.rootDir, parent, [
            ledgerGitPath(ledger, "").replace(/\/$/u, "") || ".",
          ])
        ).map(({ target }) => ({ target, logical: ledgerAuthoredPath(ledger, target) })),
        files = followerFilesFromTree({
          ledger,
          documents: prepared.documents,
          previous: previousTree,
          readContent: readContentBlob,
          requirePreviousPaths: prepared.requirePreviousPaths,
          knownDocumentPaths,
          cut: prepared.cut,
        }),
        commit = await publishFollowerCutAsync(ledger.rootDir, authoredRef, parent, checkpoint, prepared.cut, files, {
          killpoint: options.killpoint,
          finalizeRefs: runFinalizeRefsAsync,
        });
      if (prepared.materializeTree) {
        const previous =
          commit !== parent
            ? parent
            : git.commitSha !== null &&
                git.commitSha !== commit &&
                (await localGitObjectRefStoreAsync.hasCommit(ledger.rootDir, git.commitSha))
              ? git.commitSha
              : null;
        await alignFollowerIndexAsync(
          indexCut(ledger, authoredRef, parent, commit, previous, files),
          options.withFollowerFence,
          options.withFollowerFenceAsync,
        );
      }
      finalizePgWorktreeManifest(ledger, commit, prepared.cut, files, prepared.materializeTree);
    }
    return buildPgReceipt(prepared.settlements, prepared.conflicts);
  };

  const markReplicationUnconfirmed = (error: unknown): void => {
    if (error instanceof Error && error.message === "sync_replication_unconfirmed") {
      worktree = { ...worktree, status: "pending", reason: error.message };
      git = { ...git, status: "pending", reason: error.message };
    }
  };

  const publishFollower: typeof publishConfirmedFollower = (request) => {
    try {
      return publishConfirmedFollower(request);
    } catch (error) {
      markReplicationUnconfirmed(error);
      throw error;
    }
  };

  const publishFollowerAsync: typeof publishConfirmedFollowerAsync = async (request) => {
    try {
      return await publishConfirmedFollowerAsync(request);
    } catch (error) {
      markReplicationUnconfirmed(error);
      throw error;
    }
  };

  const publisher = createDurableFollowerPublisher({
    publish: publishFollower,
    publishAsync: publishFollowerAsync,
    withFence: options.withFollowerFence,
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
function followerFilesFromTree(input: {
  readonly ledger: ReturnType<typeof resolveLedgerGitLayout>;
  readonly documents: readonly {
    readonly path: string;
    readonly blobSha256: string;
    readonly size: number;
    readonly nodeKind?: "file" | "symbolic-link" | null;
  }[];
  readonly previous: readonly { readonly target: string; readonly logical: string }[];
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
    known = input.knownDocumentPaths(input.previous.map(({ logical }) => logical)),
    owned = input.previous.filter(({ logical }) => known.has(logical));
  input.requirePreviousPaths?.(owned.map(({ logical }) => logical));
  const staleManaged = owned
    .filter(({ logical }) => projectionManagedPath(logical) && !projectedLogical.has(logical))
    .map(({ target }) => ({ delete: target }));
  return [...projected, ...staleManaged];
}
