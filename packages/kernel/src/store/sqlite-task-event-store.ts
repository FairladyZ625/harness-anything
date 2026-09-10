import { type EventHead, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import {
  isTaskEvent,
  ledgerCommitSha,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { canonicalDocumentClaims, contentClaims } from "./task-event-store-claims-layout.ts";
import { canonicalEventCut, canonicalLedgerCut } from "./task-event-store-contract.ts";
import { isTaskBootstrapEvent } from "../domain/task-bootstrap-event.ts";
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
  MaterializationReceipt,
  PublicationWrite,
  PublicationDelete,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { assertAuthorizedReplacements } from "./task-event-store-replacement-authorization.ts";
import { finalizeRefs, prepareCommit } from "./task-event-store-git-refs.ts";
import {
  certifiedFollowerRevision,
  captureGitBaseline,
  followerDirectories,
  followerFiles,
  legacyRetirements,
  ledgerWorktreeBaseline,
  physicalWorktreeRevision,
  settleWorktree,
  settleWorktreeDirectories,
  worktreeFingerprint,
  publicationDigest,
  readPendingEvents,
  type FollowerDirectorySettlement,
} from "./sqlite-task-event-publication.ts";

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
}

export interface SqliteTaskEventStoreOptions {
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly writerFence?: () => DaemonWriterFence;
  readonly activationPreflight?: (input: { readonly rootInput: HarnessLayoutInput; readonly repoId: string }) => void;
  readonly beforeAppend?: () => void;
  readonly withAppendFence?: <T>(operation: () => T) => T;
  readonly onMaterializationHealthChange?: (health: MaterializationHealth) => void;
  readonly mutable?: boolean;
  readonly generation?: 1 | 2;
  readonly killpoint?: (point: import("./task-event-store-types.ts").EventPublicationKillpoint) => void;
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
  });
  let resolvedLedger: ReturnType<typeof resolveLedgerGitLayout> | null = null;
  const ledger = () => (resolvedLedger ??= resolveLedgerGitLayout(input));
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
    scheduled: Promise<void> | null = null,
    certified: { readonly commit: string; readonly revision: number } | null = null;

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
  const acceptedWorktree = new Map<string, { fingerprint: string; preserve: boolean }>(),
    // Each target a settlement left alone, with the bytes it would have settled there.
    worktreeConflicts = new Map<string, string>();
  const append = (bundle: CanonicalWriteBundle): CanonicalEventAppendReceipt => {
    if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    validateCanonicalWriteBundle(bundle);
    options.beforeAppend?.();
    options.killpoint?.("before_event_write");
    const members = [...(bundle.preceding ?? []), bundle],
      appended = members.map((member) => member.event),
      blobs = members.flatMap((member) => member.blobs),
      revisionBeforeAcceptance = sqlite.revision(),
      authoredRoot = resolveHarnessLayout(input).authoredRoot,
      acceptedBaseline = new Map<string, { fingerprint: string; preserve: boolean }>();
    assertAuthorizedReplacements(sqlite, input, members);
    for (const event of appended) {
      for (const claim of canonicalDocumentClaims(event)) {
        const node = localGitWorktreeSettlement.readNode(`${authoredRoot}/${claim.path}`);
        if (!node || node.mode !== "100644") continue;
        const prose =
          event.schema === "doc-event/v1" &&
          event.payload.changes.some(
            (change) => change.path === claim.path && change.policyId === "markdown-body-replaceable/v1",
          );
        if (isTaskEvent(event) || (prose && sha256Text(node.body.replace(/\r\n/gu, "\n")) === claim.sha256))
          acceptedBaseline.set(claim.path, { fingerprint: worktreeFingerprint(node), preserve: isTaskEvent(event) });
      }
    }
    const fence = options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 },
      accept = () =>
        sqlite.appendCommand({
          fence: { repoId: fence.repoId, holder: fence.holderId, epoch: fence.epoch },
          intent: {
            opId: bundle.event.opId,
            intentDigest: `sha256:${sha256Text(JSON.stringify(appended.map(serializePersistedCanonicalEvent)))}`,
            summary: bundle.event.type,
          },
          events: appended,
          blobs,
          beforeOutcome: () => options.killpoint?.("after_event_write"),
        });
    if (options.withAppendFence) options.withAppendFence(accept);
    else accept();
    if (sqlite.revision() > revisionBeforeAcceptance)
      for (const [logical, baseline] of acceptedBaseline) acceptedWorktree.set(logical, baseline);
    try {
      options.killpoint?.("after_sqlite_commit");
      // Acceptance advances the ledger head, not the already verified follower prefix.
      scheduleFollower();
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
        cut: canonicalEventCut(options.repoId, bundle.event),
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
    currentLedger: ReturnType<typeof ledger>,
    files: readonly (PublicationWrite | PublicationDelete)[],
    baseline: ReadonlyMap<string, string>,
    commit: string,
    directories: FollowerDirectorySettlement,
    restoreMissing: boolean,
  ): readonly string[] => {
    const permitted = new Map(baseline),
      preserve = new Set<string>(),
      conflicts: string[] = [];
    for (const [logical, accepted] of acceptedWorktree) {
      const target = ledgerGitPath(currentLedger, logical);
      if (
        !baseline.has(target) ||
        worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) !==
          accepted.fingerprint
      )
        continue;
      permitted.set(target, accepted.fingerprint);
      if (accepted.preserve && baseline.get(target) !== accepted.fingerprint) preserve.add(target);
    }
    const manifest = ledgerGitPath(currentLedger, "events/segments/manifest.json"),
      eligible = files.filter((file) => {
        const target = "target" in file ? file.target : file.delete,
          current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`));
        if (current === "missing" && (restoreMissing || !permitted.has(target))) permitted.set(target, "missing");
        if (current === permitted.get(target) || current === settledFingerprint(file)) return true;
        conflicts.push(target);
        return false;
      }),
      isManifest = (file: PublicationWrite | PublicationDelete) => "target" in file && file.target === manifest;
    conflicts.push(
      ...settleWorktree(
        currentLedger.rootDir,
        eligible.filter((file) => !isManifest(file)),
        permitted,
        options.killpoint,
        preserve,
        commit,
      ),
    );
    // Creating an owned directory is additive and idempotent, so it runs even when a concurrent edit made part
    // of this settlement ineligible: a partial pass must not be the reason a directory stays missing. Retiring
    // one is equally safe under a partial pass, because a directory whose files have not been removed yet is
    // still occupied and is therefore left standing.
    settleWorktreeDirectories(currentLedger.rootDir, directories);
    // A restart resumes from this manifest, so it lands only after everything it vouches for.
    conflicts.push(...settleWorktree(currentLedger.rootDir, eligible.filter(isManifest), permitted, options.killpoint));
    acceptedWorktree.clear();
    return conflicts;
  };

  /**
   * Publishes only what SQLite accepted since the followers last settled: Git on top of its certified parent, the
   * worktree against what it last held. `restoreMissing` (materialize) settles the whole closure instead.
   */
  const publishFollower = (restoreMissing = false): MaterializationReceipt => {
    const accepted = cut(),
      currentLedger = ledger(),
      currentRef = authoredRef(),
      parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, currentRef);
    if (accepted.revision === 0) {
      follower = pendingFollower("No accepted ledger cut exists to publish");
      return { status: "visible", commitSha: ledgerCommitSha(options.repoId, parent), changed: [], conflicts: [] };
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
      return { status: "visible", commitSha: ledgerCommitSha(options.repoId, parent), changed: [], conflicts: [] };
    }
    const events = readPendingEvents(sqlite, from),
      files = [...followerFiles(currentLedger, events, readContent, accepted, sqlite.metadata().generation), ...legacy],
      baseline = new Map(captureGitBaseline(currentLedger.rootDir, parent, files));
    if (restoreMissing || worktreeRevision !== verifiedRevision) {
      // The worktree last settled at another cut than Git's parent, so it may still hold what the ledger held then.
      const held = new Map([
        ...ledgerWorktreeBaseline(currentLedger, sqlite, worktreeRevision, files),
        ...recoverGeneratedWorktreeBaseline(currentLedger, events),
      ]);
      for (const [target, previous] of held)
        if (
          worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) !==
          baseline.get(target)
        )
          baseline.set(target, previous);
    }
    let commit = parent;
    if (verifiedRevision < accepted.revision) {
      const tempRef = `refs/ha-sqlite-outbox/${sha256Text(`${accepted.revision}:${accepted.headDigest}`)}`;
      commit = prepareCommit(
        currentLedger.rootDir,
        tempRef,
        parent,
        files,
        `outbox-${accepted.revision}`,
        new Date().toISOString(),
      );
      options.killpoint?.("after_git_commit");
      finalizeRefs(currentLedger.rootDir, currentRef, commit, parent, tempRef);
      options.killpoint?.("after_git_ref_update");
      certified = { commit, revision: accepted.revision };
    }
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      worktree: pendingFollower("worktree settlement has not verified the Git cut").worktree,
    };
    localGitWorktreeSettlement.index(currentLedger.rootDir, files);
    const skipped = new Set(
      settleFollowerWorktree(
        currentLedger,
        files,
        baseline,
        commit,
        followerDirectories(currentLedger, events),
        restoreMissing,
      ),
    );
    // A skipped target is never retried on its own: it stays reported until settled or its settled bytes appear.
    for (const [target, settled] of worktreeConflicts)
      if (worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) === settled)
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
    options.onMaterializationHealthChange?.(health("ok"));
    return { status: "visible", commitSha: ledgerCommitSha(options.repoId, commit), changed: [], conflicts };
  };

  const scheduleFollower = (): Promise<void> => {
    if (scheduled) return scheduled;
    scheduled = new Promise((resolve) =>
      setImmediate(() => {
        if (closed) {
          resolve();
          return;
        }
        try {
          publishFollower();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          consumeKnownError(error);
          const pending = pendingFollower(reason);
          follower = {
            git:
              follower.git.status === "verified" && follower.git.cut?.revision === sqlite.revision()
                ? follower.git
                : pending.git,
            worktree: pending.worktree,
          };
          options.onMaterializationHealthChange?.(health("failed", reason));
        } finally {
          scheduled = null;
          resolve();
        }
      }),
    );
    return scheduled;
  };

  if (options.mutable !== false) void scheduleFollower();

  return {
    canonicalRef: `sqlite:generation-${sqlite.metadata().generation}`,
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
    materialize: () => publishFollower(true),
    materializationHealth: () =>
      health(
        follower.git.status === "verified" && follower.git.cut?.revision === sqlite.revision()
          ? "ok"
          : scheduled
            ? "retrying"
            : "failed",
        follower.git.reason,
      ),
    drain: async () => {
      await scheduled;
      if (!closed) sqlite.close();
      closed = true;
    },
    settlePendingMaterialization: scheduleFollower,
    readCommandOutcome: sqlite.readCommandOutcome,
    ledgerMetadata: sqlite.metadata,
    followerStatus: () => follower,
  };

  function health(state: "ok" | "retrying" | "failed", reason?: string): MaterializationHealth {
    return {
      state,
      lastCheckpointRevision: follower.git.cut?.revision ?? 0,
      lastCheckpointAt: follower.git.status === "verified" ? new Date().toISOString() : null,
      pendingWalEvents: sqlite.revision() - (follower.git.cut?.revision ?? 0),
      ...(reason ? { reason: "deterministic_failure", lastError: reason } : {}),
    };
  }
}

/** A machine-written file the window restates may still hold any earlier snapshot of it that an interrupted pass left. */
function recoverGeneratedWorktreeBaseline(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  events: readonly CanonicalEventV1[],
): ReadonlyMap<string, string> {
  const recovered = new Map<string, string>(),
    observed = new Map<string, string>();
  for (const event of events) {
    const claims = isTaskEvent(event)
      ? (event.payload.documentClaims ?? [])
      : isTaskBootstrapEvent(event)
        ? event.payload.initialDocumentClaims
        : [];
    for (const claim of claims) {
      if (claim.policyId !== "typed-machine-writer/v1") continue;
      const target = ledgerGitPath(ledger, claim.path),
        fingerprint = `100644:${claim.sha256}:${claim.size}`;
      if (!observed.has(target))
        observed.set(target, worktreeFingerprint(localGitWorktreeSettlement.readNode(`${ledger.rootDir}/${target}`)));
      if (observed.get(target) === fingerprint) recovered.set(target, fingerprint);
    }
  }
  return recovered;
}

function settledFingerprint(file: PublicationWrite | PublicationDelete): string {
  return "target" in file ? `${file.mode}:${publicationDigest(file.body)}:${Buffer.byteLength(file.body)}` : "missing";
}

function pendingFollower(reason: string): { readonly git: FollowerFacet; readonly worktree: FollowerFacet } {
  return {
    git: { status: "pending", cut: null, commitSha: null, reason },
    worktree: { status: "pending", cut: null, commitSha: null, reason },
  };
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
