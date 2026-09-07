import { type EventHead, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import {
  isTaskEvent,
  ledgerCommitSha,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { sha256Bytes, sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { consumeKnownError } from "../error-consumption.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
  contentClaims,
} from "./task-event-store-claims-layout.ts";
import { canonicalEventCut, canonicalLedgerCut } from "./task-event-store-contract.ts";
import { resolveLedgerGitLayout, ledgerGitPath } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { openSqliteEventStore, type SqliteCommandOutcome } from "./sqlite-event-store.ts";
import type { SqliteEventStore } from "./sqlite-event-store.ts";
import { validateCanonicalWriteBundle } from "./task-event-store-contract.ts";
import type {
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  CanonicalWriteBundle,
  EventFileBatch,
  MaterializationHealth,
  PublicationFile,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { assertAuthorizedReplacements } from "./task-event-store-replacement-authorization.ts";
import { finalizeRefs, prepareCommit } from "./task-event-store-git-refs.ts";

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

export interface CertifiedGitFollower {
  readonly commitSha: string;
  readonly cut: LedgerCutIdentity;
  readonly documents: readonly {
    readonly path: string;
    readonly mode: "100644" | "120000";
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly retirements: readonly string[];
}

export function publishConvertedGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly store: SqliteEventStore;
  readonly authoredBranch?: string;
}): { readonly commitSha: string; readonly revision: number; readonly changed: boolean } {
  const ledger = resolveLedgerGitLayout(input.rootInput),
    branch = input.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
  const authoredRef = `refs/heads/${branch}`,
    parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
    revision = input.store.revision(),
    event = input.store.eventAtRevision(revision),
    cut = canonicalLedgerCut(input.repoId, event ? eventHead(event) : null),
    files = followerFiles(ledger, parent, readEventsThrough(input.store, revision), input.store.readContentObject, cut),
    manifestTarget = ledgerGitPath(ledger, "events/segments/manifest.json"),
    alreadyCertified =
      localGitObjectRefStore.readPath(ledger.rootDir, parent, manifestTarget) !== null &&
      certifiedFollowerRevision(ledger, parent, input.store) === revision;
  if (alreadyCertified) {
    const baseline = captureGitBaseline(ledger.rootDir, parent, files);
    if (!worktreeMatchesBaseline(ledger.rootDir, baseline, files) || !settleWorktree(ledger.rootDir, files, baseline))
      throw new TaskEventStoreError("publication_indeterminate", "authored worktree has concurrent edits");
    verifyWorktreeFiles(ledger.rootDir, files);
    return { commitSha: parent, revision, changed: false };
  }
  const tempRef = `refs/ha-sqlite-outbox/${sha256Text(`conversion:${revision}:${cut.headDigest}`)}`,
    commit = prepareCommit(ledger.rootDir, tempRef, parent, files, `conversion-${revision}`, new Date().toISOString()),
    baseline = captureGitBaseline(ledger.rootDir, parent, files);
  finalizeRefs(ledger.rootDir, authoredRef, commit, parent, tempRef);
  verifyGitFiles(ledger.rootDir, commit, files);
  verifyAuthoredRef(ledger.rootDir, authoredRef, commit);
  if (!worktreeMatchesBaseline(ledger.rootDir, baseline, files) || !settleWorktree(ledger.rootDir, files, baseline))
    throw new TaskEventStoreError("publication_indeterminate", "authored worktree has concurrent edits");
  verifyWorktreeFiles(ledger.rootDir, files);
  return { commitSha: commit, revision, changed: true };
}

export function readCertifiedGitFollower(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly store: SqliteEventStore;
  readonly authoredBranch?: string;
}): CertifiedGitFollower {
  const ledger = resolveLedgerGitLayout(input.rootInput),
    branch = input.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
  const commitSha = localGitObjectRefStore.resolveCommit(ledger.rootDir, `refs/heads/${branch}`),
    revision = certifiedFollowerRevision(ledger, commitSha, input.store);
  if (revision !== input.store.revision())
    throw new TaskEventStoreError("publication_indeterminate", "Git follower does not certify the current SQLite cut");
  const event = input.store.eventAtRevision(revision),
    cut = canonicalLedgerCut(input.repoId, event ? eventHead(event) : null),
    closure = documentClosure(readEventsThrough(input.store, revision));
  verifyDocumentClosure(ledger, commitSha, closure);
  return {
    commitSha,
    cut,
    documents: [...closure.documents.entries()]
      .map(([path, value]) => ({ path, ...value }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    retirements: [...closure.retirements].sort(),
  };
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
      follower = pendingFollower("Git follower has not verified the accepted ledger cut");
      scheduleFollower();
      options.killpoint?.("before_response_write");
      const receipt: CanonicalEventAppendReceipt = {
        status: "applied",
        event: bundle.event,
        revision: bundle.event.workspaceRevision,
        commitSha: follower.git.commitSha ? ledgerCommitSha(options.repoId, follower.git.commitSha) : null,
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
    files: readonly PublicationFile[],
    baseline: ReadonlyMap<string, string>,
    commit: string,
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
    if (!worktreeMatchesBaseline(currentLedger.rootDir, permitted, files)) return false;
    if (!settleWorktree(currentLedger.rootDir, files, permitted, options.killpoint, preserve, commit)) return false;
    verifyWorktreeFiles(currentLedger.rootDir, files);
    acceptedWorktree.clear();
    return true;
  };

  const publishFollower = () => {
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
      files = followerFiles(currentLedger, parent, pendingEvents, readContent, accepted);
    certified = { commit: parent, revision: verifiedRevision };
    if (verifiedRevision === accepted.revision) {
      const closureFiles = followerFiles(
          currentLedger,
          parent,
          readEventsThrough(sqlite, accepted.revision),
          readContent,
          accepted,
        ),
        baseline = new Map([
          ...captureGitBaseline(
            currentLedger.rootDir,
            accepted.revision > 0 ? localGitObjectRefStore.resolveCommit(currentLedger.rootDir, `${parent}^`) : parent,
            closureFiles,
          ),
          ...(pendingWorktreeBaseline ?? []),
        ]);
      follower = {
        git: { status: "verified", cut: accepted, commitSha: parent },
        worktree: pendingFollower("worktree settlement has not verified the Git cut").worktree,
      };
      pendingWorktreeBaseline = baseline;
      if (settleFollowerWorktree(currentLedger, closureFiles, baseline, parent)) {
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
    if (settleFollowerWorktree(currentLedger, files, baseline, commit)) {
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
    canonicalRef: "sqlite:generation-1",
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
    materialize: publishFollower,
    materializationHealth: () =>
      health(follower.git.status === "verified" ? "ok" : scheduled ? "retrying" : "failed", follower.git.reason),
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

function pendingFollower(reason: string): { readonly git: FollowerFacet; readonly worktree: FollowerFacet } {
  return {
    git: { status: "pending", cut: null, commitSha: null, reason },
    worktree: { status: "pending", cut: null, commitSha: null, reason },
  };
}

function followerFiles(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  parent: string,
  events: readonly CanonicalEventV1[],
  readContent: (sha256: string) => Uint8Array | null,
  cut: LedgerCutIdentity,
): PublicationFile[] {
  const latest = new Map<string, { body: string; mode: "100644" | "120000" }>(),
    retired = new Set<string>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) {
      latest.delete(retirement.path);
      retired.add(retirement.path);
    }
    for (const claim of canonicalDocumentClaims(event)) {
      const bytes = readContent(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
        throw new TaskEventStoreError("invalid_store", `content object ${claim.sha256} is missing or corrupt`);
      latest.set(claim.path, {
        body: Buffer.from(bytes).toString("utf8"),
        mode: canonicalDocumentMode(event, claim.path),
      });
      retired.delete(claim.path);
    }
  }
  const manifest = `${JSON.stringify({ schema: "sqlite-ledger-segment-manifest/v1", generation: 1, cut })}\n`;
  const eventsPrefix = ledgerGitPath(ledger, "events/"),
    objectsPrefix = ledgerGitPath(ledger, "objects/sha256/");
  for (const entry of localGitObjectRefStore.listTree(ledger.rootDir, parent)) {
    if (
      (entry.target.startsWith(eventsPrefix) && !entry.target.endsWith("events/segments/manifest.json")) ||
      entry.target.startsWith(objectsPrefix)
    )
      retired.add(entry.target);
  }
  return [
    ...[...latest].map(([target, value]) => ({ target: ledgerGitPath(ledger, target), ...value })),
    ...[...retired].map((target) => ({
      delete: target.startsWith(ledger.authoredPrefix) ? target : ledgerGitPath(ledger, target),
    })),
    { target: ledgerGitPath(ledger, "events/segments/manifest.json"), body: manifest, mode: "100644" },
  ];
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

function readPendingEvents(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
): readonly CanonicalEventV1[] {
  const events: CanonicalEventV1[] = [];
  let cursor = revision;
  for (;;) {
    const page = sqlite.eventsAfter(cursor);
    events.push(...page);
    if (page.length < 4096) return events;
    cursor = page.at(-1)!.workspaceRevision;
  }
}

function certifiedFollowerRevision(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  commit: string,
  sqlite: ReturnType<typeof openSqliteEventStore>,
): number {
  const target = ledgerGitPath(ledger, "events/segments/manifest.json"),
    bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, target);
  if (!bytes) return 0;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      readonly generation?: unknown;
      readonly cut?: { repoId?: unknown; revision?: unknown; headDigest?: unknown };
    };
    const revision = Number(parsed.cut?.revision);
    if (
      parsed.generation !== 1 ||
      parsed.cut?.repoId !== sqlite.metadata().repoId ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision > sqlite.revision()
    )
      throw new TaskEventStoreError("publication_indeterminate", "Git follower manifest identity is invalid");
    const event = sqlite.eventAtRevision(revision),
      expected = canonicalLedgerCut(sqlite.metadata().repoId, event ? eventHead(event) : null);
    if (parsed.cut.headDigest !== expected.headDigest)
      throw new TaskEventStoreError("publication_indeterminate", "Git follower manifest cut differs from SQLite");
    const closure = followerFiles(
      ledger,
      commit,
      readEventsThrough(sqlite, revision),
      sqlite.readContentObject,
      expected,
    );
    verifyGitFiles(ledger.rootDir, commit, closure);
    return revision;
  } catch (error) {
    if (error instanceof TaskEventStoreError) throw error;
    throw new TaskEventStoreError("publication_indeterminate", "Git follower manifest cannot be decoded");
  }
}

function eventHead(event: CanonicalEventV1): EventHead {
  return {
    revision: event.workspaceRevision,
    opId: event.opId,
    eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
  };
}

function readEventsThrough(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
): readonly CanonicalEventV1[] {
  return readPendingEvents(sqlite, 0).filter((event) => event.workspaceRevision <= revision);
}

function documentClosure(events: readonly CanonicalEventV1[]): {
  readonly documents: ReadonlyMap<
    string,
    { readonly mode: "100644" | "120000"; readonly sha256: string; readonly size: number }
  >;
  readonly retirements: ReadonlySet<string>;
} {
  const documents = new Map<
      string,
      { readonly mode: "100644" | "120000"; readonly sha256: string; readonly size: number }
    >(),
    retirements = new Set<string>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) {
      documents.delete(retirement.path);
      retirements.add(retirement.path);
    }
    for (const claim of canonicalDocumentClaims(event)) {
      documents.set(claim.path, {
        mode: canonicalDocumentMode(event, claim.path),
        sha256: claim.sha256,
        size: claim.size,
      });
      retirements.delete(claim.path);
    }
  }
  return { documents, retirements };
}

function verifyDocumentClosure(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  commit: string,
  closure: ReturnType<typeof documentClosure>,
): void {
  const modes = new Map(
    localGitObjectRefStore.listTree(ledger.rootDir, commit).map((entry) => [entry.target, entry.mode]),
  );
  for (const [logical, expected] of closure.documents) {
    const target = ledgerGitPath(ledger, logical),
      bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, target);
    if (
      bytes === null ||
      bytes.byteLength !== expected.size ||
      sha256Text(bytes.toString("utf8")) !== expected.sha256 ||
      modes.get(target) !== expected.mode
    )
      throw new TaskEventStoreError("publication_indeterminate", `Git follower document differs at ${logical}`);
  }
  for (const logical of closure.retirements)
    if (localGitObjectRefStore.readPath(ledger.rootDir, commit, ledgerGitPath(ledger, logical)) !== null)
      throw new TaskEventStoreError("publication_indeterminate", `Git follower retirement differs at ${logical}`);
}

function verifyGitFiles(repoRoot: string, commit: string, files: readonly PublicationFile[]): void {
  const modes = new Map(localGitObjectRefStore.listTree(repoRoot, commit).map((entry) => [entry.target, entry.mode]));
  for (const file of files) {
    if ("target" in file) {
      const body = localGitObjectRefStore.readPath(repoRoot, commit, file.target)?.toString("utf8") ?? null;
      if (body !== file.body || modes.get(file.target) !== file.mode)
        throw new TaskEventStoreError("publication_indeterminate", `Git follower read-back differs at ${file.target}`);
    } else if ("delete" in file && localGitObjectRefStore.readPath(repoRoot, commit, file.delete) !== null) {
      throw new TaskEventStoreError("publication_indeterminate", `Git follower did not retire ${file.delete}`);
    }
  }
}

function verifyAuthoredRef(repoRoot: string, authoredRef: string, commit: string): void {
  if (localGitObjectRefStore.resolveCommit(repoRoot, authoredRef) !== commit)
    throw new TaskEventStoreError("publication_indeterminate", "authored ref moved before Git follower read-back");
}

function verifyWorktreeFiles(repoRoot: string, files: readonly PublicationFile[]): void {
  for (const file of files) {
    if ("target" in file) {
      const node = localGitWorktreeSettlement.readNode(`${repoRoot}/${file.target}`);
      if (node?.body !== file.body || node.mode !== file.mode)
        throw new Error(`worktree follower read-back differs at ${file.target}`);
    } else if ("delete" in file && localGitWorktreeSettlement.readNode(`${repoRoot}/${file.delete}`) !== null) {
      throw new Error(`worktree follower did not retire ${file.delete}`);
    }
  }
}

function settleWorktree(
  repoRoot: string,
  files: readonly PublicationFile[],
  baseline: ReadonlyMap<string, string>,
  killpoint?: (point: import("./task-event-store-types.ts").EventPublicationKillpoint) => void,
  preserve: ReadonlySet<string> = new Set(),
  commit = "",
): boolean {
  const deletes = files.flatMap((file) => ("delete" in file ? [file.delete] : [])),
    writes = files.flatMap((file) => ("target" in file ? [file] : []));
  for (const target of deletes)
    if (
      !settleVisibleChange(repoRoot, target, "missing", baseline, killpoint, (hooks) =>
        localGitWorktreeSettlement.deleteVisible(repoRoot, [target], hooks),
      )
    )
      return false;
  for (const file of writes)
    if (
      !settleVisibleChange(
        repoRoot,
        file.target,
        `${file.mode}:${sha256Text(file.body)}:${Buffer.byteLength(file.body)}`,
        baseline,
        killpoint,
        (hooks) => {
          if (preserve.has(file.target)) {
            hooks.beforeRename();
            const node = localGitWorktreeSettlement.readNode(`${repoRoot}/${file.target}`);
            if (node && node.body !== file.body)
              localGitWorktreeSettlement.preserveVisibleConflict(
                repoRoot,
                `${repoRoot}/${file.target}`,
                file.target,
                commit,
              );
          }
          localGitWorktreeSettlement.visible(repoRoot, [file], hooks);
        },
      )
    )
      return false;
  return true;
}

function settleVisibleChange(
  repoRoot: string,
  target: string,
  settled: string,
  baseline: ReadonlyMap<string, string>,
  killpoint: ((point: import("./task-event-store-types.ts").EventPublicationKillpoint) => void) | undefined,
  apply: (hooks: { readonly beforeRename: () => void; readonly afterRename: () => void }) => void,
): boolean {
  let changed = false;
  const conflict = new Error("authored worktree changed during settlement");
  try {
    const hooks = {
      beforeRename: () => {
        killpoint?.("before_worktree_rename");
        const current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${repoRoot}/${target}`));
        if (current !== baseline.get(target) && current !== settled) {
          changed = true;
          throw conflict;
        }
      },
      afterRename: () => killpoint?.("after_worktree_rename"),
    };
    apply(hooks);
  } catch (error) {
    if (changed && error === conflict) return false;
    throw error;
  }
  return true;
}

function captureGitBaseline(
  repoRoot: string,
  commit: string,
  files: readonly PublicationFile[],
): ReadonlyMap<string, string> {
  const modes = new Map(localGitObjectRefStore.listTree(repoRoot, commit).map((entry) => [entry.target, entry.mode]));
  return new Map(
    files.flatMap((file) => {
      const target = "target" in file ? file.target : "delete" in file ? file.delete : null;
      if (target === null) return [];
      const bytes = localGitObjectRefStore.readPath(repoRoot, commit, target);
      return [
        [
          target,
          bytes === null ? "missing" : `${modes.get(target)}:${sha256Text(bytes.toString("utf8"))}:${bytes.byteLength}`,
        ],
      ];
    }),
  );
}

function worktreeMatchesBaseline(
  repoRoot: string,
  baseline: ReadonlyMap<string, string>,
  files: readonly PublicationFile[],
): boolean {
  const settled = new Map(
    files.flatMap((file) =>
      "target" in file
        ? [[file.target, `${file.mode}:${sha256Text(file.body)}:${Buffer.byteLength(file.body)}`]]
        : "delete" in file
          ? [[file.delete, "missing"]]
          : [],
    ),
  );
  for (const [target, fingerprint] of baseline) {
    const current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${repoRoot}/${target}`));
    if (current !== fingerprint && current !== settled.get(target)) return false;
  }
  return true;
}

function worktreeFingerprint(node: ReturnType<typeof localGitWorktreeSettlement.readNode>): string {
  return node === null ? "missing" : `${node.mode}:${node.sha256}:${node.size}`;
}
