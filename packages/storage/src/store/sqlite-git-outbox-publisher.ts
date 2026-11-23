import { authoredNodeFingerprint, readAuthoredNode } from "../authored-node-read.ts";
import { ledgerCommitSha } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import type {
  CanonicalEventStore,
  MaterializationHealth,
  MaterializationReceipt,
  MaterializationRequest,
  PublicationDelete,
  PublicationWrite,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { createDurableFollowerPublisher } from "./durable-follower-publisher.ts";
import { resolveLedgerGitLayout, ledgerGitPath, ledgerAuthoredPath } from "./ledger-git-layout.ts";
import {
  alignFollowerIndex,
  alignFollowerIndexAsync,
  localGitObjectRefStore,
  localGitObjectRefStoreAsync,
  localGitWorktreeSettlement,
} from "./local-version-control-system.ts";
import type { FollowerIndexCut } from "./git-follower-index.ts";
import {
  activateEmptyCanonicalGeneration,
  openSqliteEventStore,
  resolveActiveGeneration,
} from "./sqlite-event-store.ts";
import type { SqliteOutboxBaseline } from "./sqlite-event-store-types.ts";
import {
  closureFiles,
  listParentTreePaths,
  listParentTreePathsAsync,
  planFollowerSettlement,
  recoverGeneratedWorktreeBaseline,
  restoreRequestedDocuments,
  settlementRows,
  settledFingerprint,
} from "./sqlite-task-event-materialize.ts";
import {
  certifiedFollowerRevisionFromManifest,
  captureGitBaseline,
  captureGitBaselineAsync,
  followerDirectories,
  FOLLOWER_MANIFEST_PATH,
  legacyRetirements,
  legacyRetirementsAsync,
  ledgerWorktreeBaseline,
  peekFollowerManifestRevision,
  settleWorktree,
  settleWorktreeDirectories,
  type FollowerDirectorySettlement,
} from "./sqlite-task-event-publication.ts";
import {
  makeSqliteTaskEventStore,
  pendingFollower,
  type SqliteCanonicalEventStore,
  type SqliteGitFollowerHandle,
  type SqliteGitFollowerMountContext,
  type SqliteTaskEventStoreOptions,
} from "./sqlite-task-event-store.ts";
import {
  finalizeRefs,
  finalizeRefsAsync,
  publishFollowerCut,
  publishFollowerCutAsync,
} from "./task-event-store-git-refs.ts";

/** Mount Git ref + authored worktree settlement onto a SQLite canonical event store outside writer isolation. */
export function attachSqliteGitFollower(context: SqliteGitFollowerMountContext): SqliteGitFollowerHandle {
  const { input, options, sqlite, cut, readContent, latestAppendLayout } = context;
  let resolvedLedger: ReturnType<typeof resolveLedgerGitLayout> | null = null;
  const ledger = () => (resolvedLedger ??= resolveLedgerGitLayout(input));
  const authoredRef = () => {
    const current = ledger(),
      branch = options.authoredBranch ?? localGitObjectRefStore.currentBranch(current.rootDir);
    if (!branch) throw new Error("authored branch is detached");
    return `refs/heads/${branch}`;
  };
  let settledWorktreeRevision: number | null = null,
    follower = pendingFollower("Git follower has not published this ledger cut"),
    certified: { readonly commit: string; readonly revision: number } | null = null;
  const acceptedWorktree = new Map<string, SqliteOutboxBaseline>(),
    acceptedWorktreeRevisions = new Map<string, number>(),
    worktreeConflicts = new Map<string, string>();

  const materializeContext = () => ({
    repoId: options.repoId,
    killpoint: options.killpoint,
    withFence: options.withFollowerFence,
    cut,
    ledger,
    authoredRef,
    sqlite,
    readContent,
    readMaterializationDocuments: options.readMaterializationDocuments,
    acceptedWorktree,
    worktreeConflicts,
    layout: () => resolveHarnessLayout(input),
  });

  /** Returns the targets left alone: bytes that are neither baseline nor settled are a concurrent edit, and win. */
  const settleFollowerWorktree = (
    layout: ReturnType<typeof resolveHarnessLayout>,
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    files: readonly (PublicationWrite | PublicationDelete)[],
    baseline: ReadonlyMap<string, string>,
    commit: string,
    directories: FollowerDirectorySettlement,
    restoreMissing: boolean,
    snapshotBaselines: ReadonlyMap<string, SqliteOutboxBaseline>,
    settledRevision: number,
  ): { readonly settlements: MaterializationReceipt["settlements"]; readonly conflicts: readonly string[] } => {
    const plan = planFollowerSettlement(snapshotBaselines, currentLedger, files, baseline, restoreMissing),
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
        options.withFollowerFence,
      );
    conflicts.push(...first.conflicts);
    settleWorktreeDirectories(currentLedger.rootDir, directories, options.withFollowerFence);
    const second = settleWorktree(
      layout,
      currentLedger.rootDir,
      plan.eligible.filter(isManifest),
      plan.permitted,
      options.killpoint,
      undefined,
      undefined,
      options.withFollowerFence,
    );
    conflicts.push(...second.conflicts);
    for (const [logicalPath, revision] of acceptedWorktreeRevisions) {
      if (revision <= settledRevision) {
        acceptedWorktreeRevisions.delete(logicalPath);
        acceptedWorktree.delete(logicalPath);
      }
    }
    for (const logicalPath of acceptedWorktree.keys())
      if (!acceptedWorktreeRevisions.has(logicalPath)) acceptedWorktree.delete(logicalPath);
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

  const readWorktreeManifestNode = (currentLedger: ReturnType<typeof resolveLedgerGitLayout>) =>
    settledWorktreeRevision === null
      ? localGitWorktreeSettlement.readNode(
          `${currentLedger.rootDir}/${ledgerGitPath(currentLedger, FOLLOWER_MANIFEST_PATH)}`,
        )
      : null;

  const shouldListParentTreePaths = (
    manifestBytes: Buffer | null,
    worktreeManifestNode: ReturnType<typeof readWorktreeManifestNode>,
    legacyCount: number,
    parent: string,
    restoreMissing: boolean,
  ): boolean => {
    const prelimVerified =
        certified?.commit === parent ? certified.revision : (peekFollowerManifestRevision(manifestBytes) ?? 0),
      prelimWorktree =
        settledWorktreeRevision ??
        (worktreeManifestNode?.mode === "100644" ? (peekFollowerManifestRevision(worktreeManifestNode.bytes) ?? 0) : 0),
      prelimFrom = restoreMissing || settledWorktreeRevision === null ? 0 : Math.min(prelimVerified, prelimWorktree);
    return (
      (Boolean(options.readMaterializationDocuments) && prelimFrom === 0) ||
      (!restoreMissing && prelimWorktree === prelimVerified && (settledWorktreeRevision === null || legacyCount > 0))
    );
  };

  const existingPreimage = (repoRoot: string, head: string, candidates: readonly (string | null)[]): string | null => {
    for (const candidate of candidates) {
      if (candidate !== null && candidate !== head && localGitObjectRefStore.hasCommit(repoRoot, candidate))
        return candidate;
    }
    return null;
  };

  const existingPreimageAsync = async (
    repoRoot: string,
    head: string,
    candidates: readonly (string | null)[],
  ): Promise<string | null> => {
    for (const candidate of candidates) {
      if (
        candidate !== null &&
        candidate !== head &&
        (await localGitObjectRefStoreAsync.hasCommit(repoRoot, candidate))
      )
        return candidate;
    }
    return null;
  };

  const unpublishedWorktreePreimageCandidates = (
    parent: string,
    manifestBytes: Buffer | null,
    worktreeManifestNode: ReturnType<typeof readWorktreeManifestNode>,
  ): readonly (string | null)[] => {
    if (settledWorktreeRevision !== null || !options.readMaterializationDocuments) return [];
    const gitRevision = peekFollowerManifestRevision(manifestBytes) ?? 0,
      diskRevision =
        worktreeManifestNode?.mode === "100644" ? (peekFollowerManifestRevision(worktreeManifestNode.bytes) ?? 0) : 0;
    if (gitRevision <= diskRevision) return [];
    // A cut can already have removed a path from Git while its preimage is still on disk.
    // The stored outbox SHA may belong to an earlier Git repository (e.g. before relocating
    // authoredRoot to a symlinked private ledger) and a root commit has no `${parent}^`.
    return [sqlite.gitOutboxState().publishedCommitSha, `${parent}^`];
  };

  const planSqlitePublicationSnapshot = (inputSnapshot: {
    readonly currentLedger: ReturnType<typeof resolveLedgerGitLayout>;
    readonly parent: string;
    readonly manifestBytes: Buffer | null;
    readonly worktreeManifestNode: ReturnType<typeof readWorktreeManifestNode>;
    readonly legacy: readonly PublicationDelete[];
    readonly parentTreePaths: readonly string[] | undefined;
    readonly restoreMissing: boolean;
    readonly reconcileNodePolicy: boolean;
  }) =>
    sqlite.readSnapshot(() => {
      const accepted = cut();
      if (accepted.revision === 0) return { kind: "empty" as const, accepted };
      const outbox = sqlite.gitOutboxState(),
        verifiedRevision =
          certified?.commit === inputSnapshot.parent
            ? certified.revision
            : certifiedFollowerRevisionFromManifest(inputSnapshot.manifestBytes, sqlite),
        worktreeRevision =
          settledWorktreeRevision ??
          (inputSnapshot.worktreeManifestNode?.mode === "100644"
            ? certifiedFollowerRevisionFromManifest(inputSnapshot.worktreeManifestNode.bytes, sqlite)
            : 0),
        from =
          inputSnapshot.restoreMissing || settledWorktreeRevision === null
            ? 0
            : Math.min(verifiedRevision, worktreeRevision);
      if (from === accepted.revision && inputSnapshot.legacy.length === 0 && settledWorktreeRevision !== null)
        return { kind: "already-current" as const, accepted, verifiedRevision };
      const snapshotBaselines = new Map<string, SqliteOutboxBaseline>();
      for (const [logicalPath, entry] of acceptedWorktree)
        if ((acceptedWorktreeRevisions.get(logicalPath) ?? 0) <= accepted.revision)
          snapshotBaselines.set(logicalPath, entry);
      for (const [logicalPath, baseline] of outbox.baselines)
        if (!snapshotBaselines.has(logicalPath)) snapshotBaselines.set(logicalPath, baseline);
      const skipUnchanged =
          !inputSnapshot.restoreMissing &&
          worktreeRevision === accepted.revision &&
          verifiedRevision === accepted.revision,
        closure = closureFiles(
          materializeContext(),
          accepted,
          from,
          [],
          skipUnchanged,
          inputSnapshot.reconcileNodePolicy,
          inputSnapshot.reconcileNodePolicy && options.storage?.nodeTaskMaterializationPolicy === "none",
          inputSnapshot.parentTreePaths,
        ),
        files = [...closure.files, ...inputSnapshot.legacy],
        heldWorktreeBaseline =
          inputSnapshot.restoreMissing || worktreeRevision !== verifiedRevision
            ? new Map([
                ...ledgerWorktreeBaseline(inputSnapshot.currentLedger, sqlite, worktreeRevision, files),
                ...recoverGeneratedWorktreeBaseline(inputSnapshot.currentLedger, closure.events),
              ])
            : null,
        layout = latestAppendLayout() ?? resolveHarnessLayout(input),
        directories = followerDirectories(
          inputSnapshot.currentLedger,
          closure.events,
          files,
          from === 0 ? sqlite.directoryClaims() : undefined,
          layout.decisionsRoot,
          { cold: from === 0 },
        );
      return {
        kind: "publish" as const,
        accepted,
        verifiedRevision,
        worktreeRevision,
        publishedCommit: outbox.publishedCommitSha,
        closure,
        files,
        legacy: inputSnapshot.legacy,
        snapshotBaselines,
        heldWorktreeBaseline,
        layout,
        directories,
      };
    });

  const handleEmptyOrCurrentSnapshot = (
    snapshot:
      | { readonly kind: "empty"; readonly accepted: ReturnType<typeof cut> }
      | {
          readonly kind: "already-current";
          readonly accepted: ReturnType<typeof cut>;
          readonly verifiedRevision: number;
        },
    parent: string,
    preview: boolean,
  ): MaterializationReceipt => {
    if (snapshot.kind === "empty") {
      if (!preview) follower = pendingFollower("No accepted ledger cut exists to publish");
      return {
        status: preview ? "planned" : "visible",
        commitSha: ledgerCommitSha(options.repoId, parent),
        settlements: [],
        conflicts: [],
      };
    }
    certified = { commit: parent, revision: snapshot.verifiedRevision };
    settledWorktreeRevision = snapshot.accepted.revision;
    follower = {
      git: { status: "verified", cut: snapshot.accepted, commitSha: parent },
      worktree:
        follower.worktree.cut?.revision === snapshot.accepted.revision
          ? follower.worktree
          : { status: "verified", cut: snapshot.accepted, commitSha: parent, conflicts: [] },
    };
    recordPublishedOutbox(snapshot.accepted.revision, parent, true);
    return {
      status: "visible",
      commitSha: ledgerCommitSha(options.repoId, parent),
      settlements: [],
      conflicts: [],
    };
  };

  const mergePublicationBaseline = (
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    gitBaseline: ReadonlyMap<string, string>,
    closure: ReturnType<typeof closureFiles>,
    heldWorktreeBaseline: ReadonlyMap<string, string> | null,
  ): Map<string, string> => {
    const baseline = new Map(gitBaseline);
    if ("recoveredBaseline" in closure && closure.recoveredBaseline)
      for (const [target, previous] of closure.recoveredBaseline)
        if (!baseline.has(target) || baseline.get(target) === "missing") baseline.set(target, previous);
    if (heldWorktreeBaseline)
      for (const [target, previous] of heldWorktreeBaseline)
        if (authoredNodeFingerprint(readAuthoredNode(`${currentLedger.rootDir}/${target}`)) !== baseline.get(target))
          baseline.set(target, previous);
    return baseline;
  };

  const buildPreviewReceipt = (
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    parent: string,
    files: readonly (PublicationWrite | PublicationDelete)[],
    baseline: ReadonlyMap<string, string>,
    snapshotBaselines: ReadonlyMap<string, SqliteOutboxBaseline>,
    restoreMissing: boolean,
  ): MaterializationReceipt => {
    const plan = planFollowerSettlement(snapshotBaselines, currentLedger, files, baseline, restoreMissing);
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
  };

  const markGitCutVerified = (accepted: ReturnType<typeof cut>, commit: string) => {
    certified = { commit, revision: accepted.revision };
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      // Keep the last worktree cut usable while settlement of the newer Git cut is pending.
      worktree: { ...follower.worktree, status: "pending", reason: "worktree settlement has not verified the Git cut" },
    };
  };

  type PublishedSnapshot = Extract<ReturnType<typeof planSqlitePublicationSnapshot>, { readonly kind: "publish" }>;
  const finishWorktreeSettlement = (
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    snapshot: PublishedSnapshot,
    commit: string,
    settled: ReturnType<typeof settleFollowerWorktree>,
  ): MaterializationReceipt => {
    const skipped = new Set(settled.conflicts);
    for (const [target, settledBytes] of worktreeConflicts)
      if (authoredNodeFingerprint(readAuthoredNode(`${currentLedger.rootDir}/${target}`)) === settledBytes)
        worktreeConflicts.delete(target);
    for (const file of snapshot.files) {
      const target = "target" in file ? file.target : file.delete;
      if (skipped.has(target)) worktreeConflicts.set(target, settledFingerprint(file));
      else worktreeConflicts.delete(target);
    }
    settledWorktreeRevision = snapshot.accepted.revision;
    recordPublishedOutbox(snapshot.accepted.revision, commit, true);
    const conflicts = [...worktreeConflicts.keys()].sort();
    follower = {
      git: follower.git,
      worktree:
        conflicts.length === 0
          ? { status: "verified", cut: snapshot.accepted, commitSha: commit, conflicts }
          : {
              status: "pending",
              cut: snapshot.accepted,
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

  const indexPreviousCandidates = (snapshot: PublishedSnapshot, parent: string): readonly (string | null)[] => [
    snapshot.publishedCommit,
    snapshot.verifiedRevision > snapshot.worktreeRevision ? `${parent}^` : null,
  ];

  const indexCut = (
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    currentRef: string,
    snapshot: PublishedSnapshot,
    parent: string,
    commit: string,
    previous: string | null,
    tree: NonNullable<FollowerIndexCut["transition"]>["tree"],
  ): FollowerIndexCut => ({
    repoRoot: currentLedger.rootDir,
    authoredRef: currentRef,
    authoredPrefix: currentLedger.authoredPrefix,
    head: commit,
    previous,
    ...(commit === parent ? { visibility: snapshot.files } : { transition: { files: snapshot.files, tree } }),
    ...(snapshot.legacy.length === 0
      ? {}
      : { retiredLegacyPaths: new Set(snapshot.legacy.map((file) => file.delete)) }),
    ...(settledWorktreeRevision === null
      ? {
          ownedDocuments: (targets) =>
            new Set(
              targets.filter((target) => sqlite.documentHead(ledgerAuthoredPath(currentLedger, target)) !== undefined),
            ),
        }
      : {}),
  });

  const settleSnapshot = (
    currentLedger: ReturnType<typeof resolveLedgerGitLayout>,
    snapshot: PublishedSnapshot,
    baseline: ReadonlyMap<string, string>,
    commit: string,
    restoreMissing: boolean,
  ) =>
    settleFollowerWorktree(
      snapshot.layout,
      currentLedger,
      snapshot.files,
      baseline,
      commit,
      snapshot.directories,
      restoreMissing,
      snapshot.snapshotBaselines,
      snapshot.accepted.revision,
    );

  const skipByNodePolicyReceipt = (restoreMissing: boolean): MaterializationReceipt | null => {
    if (options.storage?.nodeTaskMaterializationPolicy !== "none" || restoreMissing) return null;
    const accepted = sqlite.readSnapshot(() => cut());
    follower = {
      git: { status: "pending", cut: accepted, commitSha: null, reason: "Skipped by node policy" },
      worktree: { status: "verified", cut: accepted, commitSha: null, conflicts: [] },
    };
    return { status: "visible", commitSha: null, settlements: [], conflicts: [] };
  };

  /**
   * Publishes only what SQLite accepted since the followers last settled: Git on top of its certified parent, the
   * worktree against what it last held.
   */
  const publishFollower = (
    restoreMissing = false,
    preview = false,
    reconcileNodePolicy = false,
  ): MaterializationReceipt => {
    const skipped = skipByNodePolicyReceipt(restoreMissing);
    if (skipped) return skipped;
    const currentLedger = ledger(),
      currentRef = authoredRef(),
      parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, currentRef),
      manifestBytes =
        certified?.commit === parent
          ? null
          : localGitObjectRefStore.readPath(
              currentLedger.rootDir,
              parent,
              ledgerGitPath(currentLedger, FOLLOWER_MANIFEST_PATH),
            ),
      worktreeManifestNode = readWorktreeManifestNode(currentLedger),
      legacy = settledWorktreeRevision === null ? legacyRetirements(currentLedger, null) : [],
      diskPreimage = existingPreimage(
        currentLedger.rootDir,
        parent,
        unpublishedWorktreePreimageCandidates(parent, manifestBytes, worktreeManifestNode),
      ),
      parentTreePaths = shouldListParentTreePaths(
        manifestBytes,
        worktreeManifestNode,
        legacy.length,
        parent,
        restoreMissing,
      )
        ? [
            ...new Set([
              ...listParentTreePaths(currentLedger, currentRef, parent),
              ...(diskPreimage ? listParentTreePaths(currentLedger, currentRef, diskPreimage) : []),
            ]),
          ]
        : undefined,
      snapshot = planSqlitePublicationSnapshot({
        currentLedger,
        parent,
        manifestBytes,
        worktreeManifestNode,
        legacy,
        parentTreePaths,
        restoreMissing,
        reconcileNodePolicy,
      });
    if (snapshot.kind !== "publish") return handleEmptyOrCurrentSnapshot(snapshot, parent, preview);
    certified = { commit: parent, revision: snapshot.verifiedRevision };
    const gitBaseline = captureGitBaseline(currentLedger.rootDir, parent, snapshot.files),
      baseline = mergePublicationBaseline(
        currentLedger,
        gitBaseline.worktree,
        snapshot.closure,
        snapshot.heldWorktreeBaseline,
      );
    if (preview)
      return buildPreviewReceipt(
        currentLedger,
        parent,
        snapshot.files,
        baseline,
        snapshot.snapshotBaselines,
        restoreMissing,
      );
    const commit = publishFollowerCut(
      currentLedger.rootDir,
      currentRef,
      parent,
      snapshot.verifiedRevision,
      snapshot.accepted,
      snapshot.files,
      {
        killpoint: options.killpoint,
        withFence: options.withFollowerFence,
      },
    );
    markGitCutVerified(snapshot.accepted, commit);
    const previous =
        commit !== parent
          ? parent
          : existingPreimage(currentLedger.rootDir, commit, indexPreviousCandidates(snapshot, parent)),
      index = indexCut(currentLedger, currentRef, snapshot, parent, commit, previous, gitBaseline.tree);
    if (commit !== parent) alignFollowerIndex(index, options.withFollowerFence);
    const settled = settleSnapshot(currentLedger, snapshot, baseline, commit, restoreMissing);
    if (commit === parent) alignFollowerIndex(index, options.withFollowerFence);
    return finishWorktreeSettlement(currentLedger, snapshot, commit, settled);
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

  const publishFollowerAsync = async (
    restoreMissing = false,
    preview = false,
    reconcileNodePolicy = false,
  ): Promise<MaterializationReceipt> => {
    const skipped = skipByNodePolicyReceipt(restoreMissing);
    if (skipped) return skipped;
    const currentLedger = ledger(),
      currentRef = authoredRef(),
      // The published ledger revision does not prove the current head of the Git branch.
      parent = await localGitObjectRefStoreAsync.resolveBranchCommit(currentLedger.rootDir, currentRef),
      manifestBytes =
        certified?.commit === parent
          ? null
          : await localGitObjectRefStoreAsync.readPath(
              currentLedger.rootDir,
              parent,
              ledgerGitPath(currentLedger, FOLLOWER_MANIFEST_PATH),
            ),
      worktreeManifestNode = readWorktreeManifestNode(currentLedger),
      legacy = settledWorktreeRevision === null ? await legacyRetirementsAsync(currentLedger, null) : [],
      diskPreimage = await existingPreimageAsync(
        currentLedger.rootDir,
        parent,
        unpublishedWorktreePreimageCandidates(parent, manifestBytes, worktreeManifestNode),
      ),
      parentTreePaths = shouldListParentTreePaths(
        manifestBytes,
        worktreeManifestNode,
        legacy.length,
        parent,
        restoreMissing,
      )
        ? [
            ...new Set([
              ...(await listParentTreePathsAsync(currentLedger, currentRef, parent)),
              ...(diskPreimage ? await listParentTreePathsAsync(currentLedger, currentRef, diskPreimage) : []),
            ]),
          ]
        : undefined,
      snapshot = planSqlitePublicationSnapshot({
        currentLedger,
        parent,
        manifestBytes,
        worktreeManifestNode,
        legacy,
        parentTreePaths,
        restoreMissing,
        reconcileNodePolicy,
      });
    if (snapshot.kind !== "publish") return handleEmptyOrCurrentSnapshot(snapshot, parent, preview);
    certified = { commit: parent, revision: snapshot.verifiedRevision };
    const gitBaseline = await captureGitBaselineAsync(currentLedger.rootDir, parent, snapshot.files),
      baseline = mergePublicationBaseline(
        currentLedger,
        gitBaseline.worktree,
        snapshot.closure,
        snapshot.heldWorktreeBaseline,
      );
    if (preview)
      return buildPreviewReceipt(
        currentLedger,
        parent,
        snapshot.files,
        baseline,
        snapshot.snapshotBaselines,
        restoreMissing,
      );
    const commit = await publishFollowerCutAsync(
      currentLedger.rootDir,
      currentRef,
      parent,
      snapshot.verifiedRevision,
      snapshot.accepted,
      snapshot.files,
      {
        killpoint: options.killpoint,
        finalizeRefs: runFinalizeRefsAsync,
      },
    );
    markGitCutVerified(snapshot.accepted, commit);
    const previous =
        commit !== parent
          ? parent
          : await existingPreimageAsync(currentLedger.rootDir, commit, indexPreviousCandidates(snapshot, parent)),
      index = indexCut(currentLedger, currentRef, snapshot, parent, commit, previous, gitBaseline.tree);
    if (commit !== parent)
      await alignFollowerIndexAsync(index, options.withFollowerFence, options.withFollowerFenceAsync);
    const settled = settleSnapshot(currentLedger, snapshot, baseline, commit, restoreMissing);
    if (commit === parent)
      await alignFollowerIndexAsync(index, options.withFollowerFence, options.withFollowerFenceAsync);
    return finishWorktreeSettlement(currentLedger, snapshot, commit, settled);
  };

  function recordPublishedOutbox(revision: number, commitSha: string | null, clearBaselines: boolean): void {
    if (options.mutable === false) return;
    const write = () => sqlite.markGitOutboxPublished({ revision, commitSha, clearBaselines });
    if (options.withFollowerFence) options.withFollowerFence(write);
    else write();
  }

  const publisher = createDurableFollowerPublisher({
    withFence: options.withFollowerFence,
    publish: (request) =>
      request?.paths && !request.preview
        ? restoreRequestedDocuments(materializeContext(), request.paths)
        : publishFollower(request !== undefined, request?.preview, request?.reconcileNodePolicy),
    publishAsync: (request) =>
      request?.paths && !request.preview
        ? Promise.resolve(restoreRequestedDocuments(materializeContext(), request.paths))
        : publishFollowerAsync(request !== undefined, request?.preview, request?.reconcileNodePolicy),
    revision: sqlite.revision,
    checkpoint: () => Math.min(follower.git.cut?.revision ?? 0, follower.worktree.cut?.revision ?? 0),
    onHealthChange: options.onMaterializationHealthChange,
    onFailure: (reason) => {
      certified = null;
      const pending = pendingFollower(reason);
      follower = {
        git:
          follower.git.status === "verified" && follower.git.cut?.revision === sqlite.revision()
            ? follower.git
            : pending.git,
        worktree: { ...follower.worktree, status: "pending", reason },
      };
    },
  });

  if (options.mutable !== false) void publisher.request();

  return {
    currentCommit: () =>
      ledgerCommitSha(options.repoId, localGitObjectRefStore.resolveCommit(ledger().rootDir, authoredRef())),
    followerStatus: () => follower,
    materialize: (request?: MaterializationRequest) => publisher.publish(request ?? {}),
    materializationHealth: publisher.health,
    settlePendingMaterialization: async (_context: string) => {
      await publisher.request();
    },
    request: () => {
      void publisher.request();
    },
    onAppend: (acceptedBaseline, revision) => {
      for (const [logical, entry] of acceptedBaseline) {
        acceptedWorktree.set(logical, entry);
        if (revision !== undefined) acceptedWorktreeRevisions.set(logical, revision);
      }
    },
    drain: publisher.drain,
  };
}

/** Legacy/test helper that attaches synchronous/local Git follower publication onto makeSqliteTaskEventStore. */
export function makeSqliteTaskEventStoreWithGitFollower(
  options: SqliteTaskEventStoreOptions,
): SqliteCanonicalEventStore {
  return makeSqliteTaskEventStore({
    ...options,
    attachGitFollower: options.attachGitFollower ?? attachSqliteGitFollower,
  });
}

/**
 * Drain committed SQLite `git_outbox` revisions on the Host outside the writer-cell Isolate and write lock.
 * Safe across restarts (replays durable `git_outbox_baseline`) and guarded by `withFollowerFence`.
 */
export async function publishPendingSqliteGitOutbox(options: {
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly storage?: SqliteTaskEventStoreOptions["storage"];
  readonly withFollowerFence?: <T>(operation: () => T) => T;
  readonly withFollowerFenceAsync?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly onMaterializationHealthChange?: SqliteTaskEventStoreOptions["onMaterializationHealthChange"];
  readonly readMaterializationDocuments?: SqliteTaskEventStoreOptions["readMaterializationDocuments"];
  readonly killpoint?: SqliteTaskEventStoreOptions["killpoint"];
  readonly request?: MaterializationRequest;
}): Promise<{
  readonly receipt: MaterializationReceipt;
  readonly health: MaterializationHealth;
  readonly followerStatus: ReturnType<CanonicalEventStore["followerStatus"]>;
}> {
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("outbox publisher requires rootInput or rootDir");
  const generation = resolveActiveGeneration({ rootInput: input, repoId: options.repoId }),
    store = makeSqliteTaskEventStore({
      repoId: options.repoId,
      rootInput: input,
      generation,
      authoredBranch: options.authoredBranch,
      storage: options.storage,
      withFollowerFence: options.withFollowerFence,
      withFollowerFenceAsync: options.withFollowerFenceAsync,
      onMaterializationHealthChange: options.onMaterializationHealthChange,
      readMaterializationDocuments: options.readMaterializationDocuments,
      killpoint: options.killpoint,
      activationPreflight: generation === 3 ? activateEmptyCanonicalGeneration : undefined,
      mutable: true,
      attachGitFollower: attachSqliteGitFollower,
    });
  try {
    let receipt: MaterializationReceipt;
    if (options.request) {
      receipt = store.materialize(options.request);
    } else {
      await store.settlePendingMaterialization?.("outbox-publish");
      receipt = store.materialize({});
    }
    return {
      receipt,
      health: store.materializationHealth(),
      followerStatus: store.followerStatus(),
    };
  } finally {
    await store.drain?.();
  }
}

export { readCertifiedGitFollower, type CertifiedGitFollower } from "./sqlite-task-event-publication.ts";
export { resolveLedgerGitLayout, ledgerGitPath, ledgerAuthoredPath } from "./ledger-git-layout.ts";
export { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
export { openSqliteEventStore };
