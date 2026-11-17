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
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import {
  activateEmptyCanonicalGeneration,
  openSqliteEventStore,
  resolveActiveGeneration,
} from "./sqlite-event-store.ts";
import type { SqliteOutboxBaseline } from "./sqlite-event-store-types.ts";
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
import { publishFollowerCut } from "./task-event-store-git-refs.ts";

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
    worktreeConflicts = new Map<string, string>();
  const hydrateDurableOutboxBaselines = () => {
    const outbox = sqlite.gitOutboxState();
    for (const [logicalPath, baseline] of outbox.baselines) {
      if (!acceptedWorktree.has(logicalPath)) acceptedWorktree.set(logicalPath, baseline);
    }
  };

  const materializeContext = () => ({
    repoId: options.repoId,
    killpoint: options.killpoint,
    withFence: options.withAppendFence,
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
    settleWorktreeDirectories(currentLedger.rootDir, directories, options.withAppendFence);
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
   * worktree against what it last held.
   */
  const publishFollower = (
    restoreMissing = false,
    preview = false,
    reconcileNodePolicy = false,
  ): MaterializationReceipt => {
    hydrateDurableOutboxBaselines();
    const accepted = cut();
    if (options.storage?.nodeTaskMaterializationPolicy === "none" && !restoreMissing) {
      follower = {
        git: { status: "pending", cut: accepted, commitSha: null, reason: "Skipped by node policy" },
        worktree: { status: "verified", cut: accepted, commitSha: null, conflicts: [] },
      };
      return { status: "visible", commitSha: null, settlements: [], conflicts: [] };
    }
    const currentLedger = ledger(),
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
      legacy = settledWorktreeRevision === null ? legacyRetirements(currentLedger, null) : [],
      from = restoreMissing || settledWorktreeRevision === null ? 0 : Math.min(verifiedRevision, worktreeRevision);
    certified = { commit: parent, revision: verifiedRevision };
    if (from === accepted.revision && legacy.length === 0 && settledWorktreeRevision !== null) {
      settledWorktreeRevision = accepted.revision;
      follower = {
        git: { status: "verified", cut: accepted, commitSha: parent },
        worktree:
          follower.worktree.cut?.revision === accepted.revision
            ? follower.worktree
            : { status: "verified", cut: accepted, commitSha: parent, conflicts: [] },
      };
      recordPublishedOutbox(accepted.revision, parent, true);
      return {
        status: "visible",
        commitSha: ledgerCommitSha(options.repoId, parent),
        settlements: [],
        conflicts: [],
      };
    }
    const closure = closureFiles(
        materializeContext(),
        accepted,
        from,
        [],
        !restoreMissing && worktreeRevision === accepted.revision && verifiedRevision === accepted.revision,
        reconcileNodePolicy,
        reconcileNodePolicy && options.storage?.nodeTaskMaterializationPolicy === "none",
      ),
      files = [...closure.files, ...legacy],
      baseline = new Map(captureGitBaseline(currentLedger.rootDir, parent, files));
    if ("recoveredBaseline" in closure && closure.recoveredBaseline)
      for (const [target, previous] of closure.recoveredBaseline)
        if (!baseline.has(target) || baseline.get(target) === "missing") baseline.set(target, previous);
    if (restoreMissing || worktreeRevision !== verifiedRevision) {
      const held = new Map([
        ...ledgerWorktreeBaseline(currentLedger, sqlite, worktreeRevision, files),
        ...recoverGeneratedWorktreeBaseline(currentLedger, closure.events),
      ]);
      for (const [target, previous] of held)
        if (authoredNodeFingerprint(readAuthoredNode(`${currentLedger.rootDir}/${target}`)) !== baseline.get(target))
          baseline.set(target, previous);
    }
    if (preview) {
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
    const layout = latestAppendLayout() ?? resolveHarnessLayout(input),
      settled = settleFollowerWorktree(
        layout,
        currentLedger,
        files,
        baseline,
        commit,
        followerDirectories(
          currentLedger,
          closure.events,
          files,
          from === 0 ? sqlite.directoryClaims() : undefined,
          layout.decisionsRoot,
          { cold: from === 0 },
        ),
        restoreMissing,
      );
    const skipped = new Set(settled.conflicts);
    for (const [target, settledBytes] of worktreeConflicts)
      if (authoredNodeFingerprint(readAuthoredNode(`${currentLedger.rootDir}/${target}`)) === settledBytes)
        worktreeConflicts.delete(target);
    for (const file of files) {
      const target = "target" in file ? file.target : file.delete;
      if (skipped.has(target)) worktreeConflicts.set(target, settledFingerprint(file));
      else worktreeConflicts.delete(target);
    }
    settledWorktreeRevision = accepted.revision;
    recordPublishedOutbox(accepted.revision, commit, true);
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

  function recordPublishedOutbox(revision: number, commitSha: string | null, clearBaselines: boolean): void {
    if (options.mutable === false) return;
    const write = () => sqlite.markGitOutboxPublished({ revision, commitSha, clearBaselines });
    if (options.withAppendFence) options.withAppendFence(write);
    else write();
  }

  const publisher = createDurableFollowerPublisher({
    withFence: options.withAppendFence,
    publish: (request) =>
      request?.paths && !request.preview
        ? restoreRequestedDocuments(materializeContext(), request.paths)
        : publishFollower(request !== undefined, request?.preview, request?.reconcileNodePolicy),
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
    onAppend: (acceptedBaseline) => {
      for (const [logical, entry] of acceptedBaseline) acceptedWorktree.set(logical, entry);
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
 * Safe across restarts (replays durable `git_outbox_baseline`) and guarded by `withAppendFence`.
 */
export async function publishPendingSqliteGitOutbox(options: {
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly storage?: SqliteTaskEventStoreOptions["storage"];
  readonly withAppendFence?: <T>(operation: () => T) => T;
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
      withAppendFence: options.withAppendFence,
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
