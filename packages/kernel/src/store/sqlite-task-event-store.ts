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
import { localGitObjectRefStore, localGitText, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { openSqliteEventStore, type SqliteCommandOutcome } from "./sqlite-event-store.ts";
import { validateCanonicalWriteBundle } from "./task-event-store-contract.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  CanonicalWriteBundle,
  EventFileBatch,
  MaterializationHealth,
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
  readEventsThrough,
  settleWorktree,
  settleWorktreeDirectories,
  verifyAuthoredRef,
  verifyGitFiles,
  verifyWorktreeFiles,
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
  let settledWorktreeRevision = 0,
    closed = false,
    follower = pendingFollower("Git follower has not published this ledger cut"),
    scheduled: Promise<void> | null = null,
    certified: { readonly commit: string; readonly revision: number } | null = null,
    pendingWorktreeBaseline: ReadonlyMap<string, string> | null = null;

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
  const acceptedWorktree = new Map<string, { fingerprint: string; preserve: boolean }>();
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

  const settleFollowerWorktree = (
    currentLedger: ReturnType<typeof ledger>,
    files: readonly (PublicationWrite | PublicationDelete)[],
    baseline: ReadonlyMap<string, string>,
    commit: string,
    directories: FollowerDirectorySettlement,
    restoreMissing = false,
  ): boolean => {
    const permitted = new Map(baseline),
      preserve = new Set<string>();
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
    let eligible = files.filter((file) => {
      const target = "target" in file ? file.target : file.delete,
        current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)),
        settled =
          "target" in file ? `${file.mode}:${publicationDigest(file.body)}:${Buffer.byteLength(file.body)}` : "missing";
      if (current === "missing" && (restoreMissing || !permitted.has(target))) permitted.set(target, "missing");
      return current === permitted.get(target) || current === settled;
    });
    if (eligible.length < files.length) {
      const manifest = ledgerGitPath(currentLedger, "events/segments/manifest.json");
      eligible = eligible.filter((file) => ("target" in file ? file.target : file.delete) !== manifest);
    }
    if (!settleWorktree(currentLedger.rootDir, eligible, permitted, options.killpoint, preserve, commit)) return false;
    verifyWorktreeFiles(currentLedger.rootDir, eligible);
    // Creating an owned directory is additive and idempotent, so it runs even when a concurrent edit made part
    // of this settlement ineligible: a partial pass must not be the reason a directory stays missing. Retiring
    // one is equally safe under a partial pass, because a directory whose files have not been removed yet is
    // still occupied and is therefore left standing.
    settleWorktreeDirectories(currentLedger.rootDir, directories);
    if (eligible.length < files.length) return false;
    acceptedWorktree.clear();
    return true;
  };

  const publishFollower = (restoreMissing = false) => {
    const accepted = cut(),
      currentLedger = ledger(),
      currentRef = authoredRef(),
      parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, currentRef);
    if (accepted.revision === 0) {
      follower = pendingFollower("No accepted ledger cut exists to publish");
      return {
        status: "visible" as const,
        commitSha: ledgerCommitSha(options.repoId, parent),
        changed: [],
        conflicts: [],
      };
    }
    const verifiedRevision =
        certified?.commit === parent ? certified.revision : certifiedFollowerRevision(currentLedger, parent, sqlite),
      pendingEvents = readPendingEvents(sqlite, Math.min(verifiedRevision, settledWorktreeRevision)),
      files = followerFiles(currentLedger, parent, pendingEvents, readContent, accepted, sqlite.metadata().generation);
    certified = { commit: parent, revision: verifiedRevision };
    if (verifiedRevision === accepted.revision) {
      const closureEvents = readEventsThrough(sqlite, accepted.revision),
        closureFiles = followerFiles(
          currentLedger,
          parent,
          closureEvents,
          readContent,
          accepted,
          sqlite.metadata().generation,
        ),
        physicalCommit = pendingWorktreeBaseline ? null : recoverPhysicalWorktreeCommit(currentLedger, parent, sqlite),
        baseline = pendingWorktreeBaseline
          ? new Map(pendingWorktreeBaseline)
          : physicalCommit
            ? new Map([
                ...captureGitBaseline(currentLedger.rootDir, physicalCommit, closureFiles),
                ...recoverGeneratedWorktreeBaseline(currentLedger, closureEvents),
              ])
            : new Map<string, string>();
      follower = {
        git: { status: "verified", cut: accepted, commitSha: parent },
        worktree: pendingFollower("worktree settlement has not verified the Git cut").worktree,
      };
      localGitWorktreeSettlement.index(currentLedger.rootDir, closureFiles);
      pendingWorktreeBaseline = baseline;
      if (
        settleFollowerWorktree(
          currentLedger,
          closureFiles,
          baseline,
          parent,
          followerDirectories(currentLedger, closureEvents),
          restoreMissing,
        )
      ) {
        pendingWorktreeBaseline = null;
        settledWorktreeRevision = accepted.revision;
      }
      verifyAuthoredRef(currentLedger.rootDir, currentRef, parent);
      follower = {
        git: { status: "verified", cut: accepted, commitSha: parent },
        worktree:
          settledWorktreeRevision < accepted.revision
            ? pendingFollower("authored worktree has concurrent edits").worktree
            : { status: "verified", cut: accepted, commitSha: parent, conflicts: [] },
      };
      return {
        status: "visible" as const,
        commitSha: ledgerCommitSha(options.repoId, parent),
        changed: [],
        conflicts: [],
      };
    }
    const tempRef = `refs/ha-sqlite-outbox/${sha256Text(`${accepted.revision}:${accepted.headDigest}`)}`,
      commit = prepareCommit(
        currentLedger.rootDir,
        tempRef,
        parent,
        files,
        `outbox-${accepted.revision}`,
        new Date().toISOString(),
      );
    options.killpoint?.("after_git_commit");
    const baseline = new Map(captureGitBaseline(currentLedger.rootDir, parent, files));
    for (const [target, previous] of pendingWorktreeBaseline ?? []) {
      const current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`));
      // Exact bytes from the latest certified Git cut can advance an older pending baseline.
      if (current !== baseline.get(target)) baseline.set(target, previous);
    }
    pendingWorktreeBaseline = baseline;
    finalizeRefs(currentLedger.rootDir, currentRef, commit, parent, tempRef);
    options.killpoint?.("after_git_ref_update");
    verifyGitFiles(currentLedger.rootDir, commit, files);
    verifyAuthoredRef(currentLedger.rootDir, currentRef, commit);
    certified = { commit, revision: accepted.revision };
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      worktree: pendingFollower("worktree settlement has not verified the Git cut").worktree,
    };
    localGitWorktreeSettlement.index(currentLedger.rootDir, files);
    if (
      settleFollowerWorktree(
        currentLedger,
        files,
        baseline,
        commit,
        followerDirectories(currentLedger, pendingEvents),
        restoreMissing,
      )
    ) {
      pendingWorktreeBaseline = null;
      settledWorktreeRevision = accepted.revision;
    }
    const manifest = files.find((file) => "target" in file && file.target.endsWith("events/segments/manifest.json"));
    if (!manifest || !("target" in manifest)) throw new Error("outbox manifest is absent");
    const gitReadback =
      localGitObjectRefStore.readPath(currentLedger.rootDir, commit, manifest.target)?.toString("utf8") ?? null;
    const worktreeReadback =
      localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${manifest.target}`)?.body ?? null;
    if (gitReadback !== manifest.body) throw new Error("Git follower manifest read-back did not match");
    verifyAuthoredRef(currentLedger.rootDir, currentRef, commit);
    follower = {
      git: { status: "verified", cut: accepted, commitSha: commit },
      worktree:
        settledWorktreeRevision >= accepted.revision && worktreeReadback === manifest.body
          ? { status: "verified", cut: accepted, commitSha: commit, conflicts: [] }
          : { status: "pending", cut: null, commitSha: commit, reason: "authored worktree has concurrent edits" },
    };
    options.onMaterializationHealthChange?.(health("ok"));
    return {
      status: "visible" as const,
      commitSha: ledgerCommitSha(options.repoId, commit),
      changed: [],
      conflicts: [],
    };
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

function recoverPhysicalWorktreeCommit(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  parent: string,
  sqlite: ReturnType<typeof openSqliteEventStore>,
): string | null {
  const target = ledgerGitPath(ledger, "events/segments/manifest.json"),
    physical = localGitWorktreeSettlement.readNode(`${ledger.rootDir}/${target}`)?.body ?? null;
  if (physical === null) return null;
  const commits = localGitText(
    ledger.rootDir,
    "log",
    "--first-parent",
    "--format=%H",
    `--find-object=${localGitObjectRefStore.blobOid(physical)}`,
    parent,
    "--",
    target,
  )
    .split("\n")
    .filter(Boolean);
  const commit = commits.find(
    (candidate) => localGitObjectRefStore.readPath(ledger.rootDir, candidate, target)?.toString("utf8") === physical,
  );
  if (!commit) return null;
  certifiedFollowerRevision(ledger, commit, sqlite);
  return commit;
}

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
