import { serializeCanonicalEvent } from "../domain/doc-sync.contract.ts";
import type { EventHead } from "../domain/write-chain.contract.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { eventObjectRelativePath } from "../layout/ledger-object-layout.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  canonicalDocumentMode,
  canonicalEventContentClaims,
  canonicalEventCut,
  canonicalLedgerCut,
  canonicalEventWritePlan,
  makeTaskEventStore as makeGitEventStore,
  TaskEventStoreError,
  type CanonicalEventAppendReceipt,
  type CanonicalEventStore,
  type CanonicalEventStreamV1,
  type CanonicalWriteBundle,
  type EventFileBatch,
  type EventRecoveryReceipt,
  type MaterializationReceipt,
  validateCanonicalWriteBundle,
} from "./task-event-store.ts";
import { openWalEventLog, type WalEventLog, type WalEventRecord } from "./wal-event-log.ts";
import { flushWalToGit } from "./wal-git-materializer.ts";

export { canonicalDocumentClaims, canonicalEventWritePlan, TaskEventStoreError };

const DEFAULT_FLUSH_EVENTS = 64;
const DEFAULT_FLUSH_MS = 2_000;
const DEFAULT_RETRY_LIMIT = 4;
const DEFAULT_RETRY_BASE_MS = 50;

type StoreOptions = Parameters<typeof makeGitEventStore>[0] & {
  readonly walFlushEvents?: number;
  readonly walFlushMs?: number;
  readonly walRetryLimit?: number;
  readonly walRetryBaseMs?: number;
  /** Runs after a WAL cut is durable and Git state has been reloaded. */
  readonly afterFlush?: () => void;
};

export function makeWalShadowEventStore(options: StoreOptions): CanonicalEventStore {
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("canonical event store requires rootInput or rootDir");
  const rootDir = resolveHarnessLayout(input).rootDir;
  const ledger = resolveLedgerGitLayout(input);
  const gitOptions = {
    ...options,
    beforeAppend: undefined,
    withAppendFence: undefined,
  };
  let git = makeGitEventStore(gitOptions);
  let gitHead = git.readHead();
  let gitLayout = git.layout();
  let gitBaseline = readGitBaseline(ledger, git.currentCommit().sha);
  let gitStream: CanonicalEventStreamV1 | null = null;
  const wal = openWalEventLog(rootDir);
  const flushEvents = positive(options.walFlushEvents, "HARNESS_WAL_FLUSH_EVENTS", DEFAULT_FLUSH_EVENTS);
  const flushMs = positive(options.walFlushMs, "HARNESS_WAL_FLUSH_MS", DEFAULT_FLUSH_MS);
  const retryLimit = positive(options.walRetryLimit, "HARNESS_WAL_RETRY_LIMIT", DEFAULT_RETRY_LIMIT);
  const retryBaseMs = positive(options.walRetryBaseMs, "HARNESS_WAL_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediate: ReturnType<typeof setImmediate> | null = null;
  let consecutiveFailures = 0;
  let lastFlushError: string | null = null;
  let closed = false;

  const reloadGit = (): void => {
    git = makeGitEventStore(gitOptions);
    gitHead = git.readHead();
    gitLayout = git.layout();
    gitBaseline = readGitBaseline(ledger, git.currentCommit().sha);
    gitStream = null;
  };
  const readGitStream = (): CanonicalEventStreamV1 => (gitStream ??= git.read());
  const stream = (): CanonicalEventStreamV1 => mergeStream(readGitStream(), wal.records());
  const pendingCount = (): number =>
    wal.records().filter((record) => record.revision > (gitHead?.revision ?? 0)).length;
  const hasWalRecords = (): boolean => wal.records().length > 0;
  const clearSchedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    if (immediate !== null) clearImmediate(immediate);
    timer = null;
    immediate = null;
  };
  const runFlush = (context: string): boolean => {
    clearSchedule();
    if (!hasWalRecords()) return true;
    const pendingRecords = wal.records();
    const first = pendingRecords[0]!.revision;
    const last = pendingRecords.at(-1)!.revision;
    try {
      flushWalToGit(wal, git, options);
      reloadGit();
      // Authored settlement observes the durable cut. It is intentionally outside the
      // materialization transaction: an ineligible edit must remain visible for doc status,
      // but can never make an already durable WAL cut fail.
      try {
        options.afterFlush?.();
      } catch (error) {
        console.warn(`[wal-materializer] authored settlement failed: ${walShadowErrorMessage(error)}`);
        consumeKnownError(error);
      }
      console.info(
        `[wal-materializer] materialized revisions ${first}-${last} (${context}, attempt ${consecutiveFailures + 1})`,
      );
      consecutiveFailures = 0;
      lastFlushError = null;
      return true;
    } catch (error) {
      consecutiveFailures += 1;
      lastFlushError = walShadowErrorMessage(error);
      try {
        reloadGit();
      } catch (reloadError) {
        console.warn(
          `[wal-materializer] failed to refresh Git state after materialization error: ${walShadowErrorMessage(reloadError)}`,
        );
        consumeKnownError(reloadError);
      }
      console.warn(
        `[wal-materializer] materialization failed (${context}, attempt ${consecutiveFailures}/${retryLimit}); acknowledged WAL writes remain valid: ${lastFlushError}`,
      );
      consumeKnownError(error);
      return false;
    }
  };
  const scheduleRetry = (): void => {
    if (closed || !hasWalRecords() || consecutiveFailures >= retryLimit) {
      if (consecutiveFailures >= retryLimit)
        console.warn(
          `[wal-materializer] retry budget exhausted after ${retryLimit} attempts; the next write, recovery, or drain will retry the pending WAL cut`,
        );
      return;
    }
    const delay = retryBaseMs * 2 ** Math.max(0, consecutiveFailures - 1);
    timer = setTimeout(() => {
      timer = null;
      if (!runFlush("retry")) scheduleRetry();
    }, delay);
    timer.unref?.();
  };
  const scheduleFlush = (newWrite: boolean): void => {
    if (closed || !hasWalRecords()) return;
    if (newWrite && consecutiveFailures >= retryLimit) consecutiveFailures = 0;
    if (timer !== null || immediate !== null) {
      if (pendingCount() < flushEvents || immediate !== null) return;
      clearSchedule();
    }
    if (pendingCount() >= flushEvents) {
      immediate = setImmediate(() => {
        immediate = null;
        if (!runFlush("batch threshold")) scheduleRetry();
      });
      immediate.unref();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!runFlush("batch age")) scheduleRetry();
    }, flushMs);
    timer.unref?.();
  };
  const readHead = (): EventHead | null => {
    const pending = wal.records().at(-1)?.event;
    return pending === undefined ? gitHead : eventHead(pending);
  };
  const readBatch = (cursor: string | null, maxItems: number): EventFileBatch => {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 4096)
      throw new TaskEventStoreError("invalid_store", "event batch maxItems must be between 1 and 4096");
    const records = wal.records().filter((record) => record.revision > (gitHead?.revision ?? 0));
    const walCursor = cursor === null ? -1 : records.findIndex((record) => cursorNames(record.event).includes(cursor));
    const directLayout = gitLayout;
    if (directLayout === "mixed") return git.readBatch(cursor, maxItems);
    const directCursor =
      cursor !== null && gitBaseline.eventOids.has(cursor)
        ? eventObjectRelativePath(cursor, directLayout).slice("events/".length)
        : cursor;
    const gitBatch = walCursor >= 0 ? null : git.readBatch(directCursor, maxItems);
    const gitEvents = gitBatch?.events ?? [];
    const room = maxItems - gitEvents.length;
    const walStart = walCursor >= 0 ? walCursor + 1 : gitBatch?.done ? 0 : records.length;
    const walEvents = records.slice(walStart, walStart + room).map((record) => record.event);
    const events = [...gitEvents, ...walEvents];
    const sourceRevision = readHead()?.revision ?? 0;
    const done = (gitBatch?.done ?? true) && walStart + walEvents.length >= records.length;
    return {
      sourceRevision,
      events,
      cursor: walEvents.at(-1)?.opId ?? gitBatch?.cursor ?? cursor,
      done,
      accessedItems: (gitBatch?.accessedItems ?? 0) + walEvents.length,
      prefetchContent:
        records.length === 0 && gitBatch?.prefetchContent !== undefined
          ? gitBatch.prefetchContent
          : (replay) =>
              new Map(
                replay
                  .flatMap((event) => canonicalEventContentClaims(event))
                  .map((claim) => [
                    claim.sha256,
                    wal.readContentBlob(claim.sha256) ?? git.readContentBlob(claim.sha256),
                  ]),
              ),
    };
  };
  const append = (bundle: CanonicalWriteBundle): CanonicalEventAppendReceipt => {
    validateCanonicalWriteBundle(bundle);
    const records = wal.records();
    const pendingEvents = records.map((record) => record.event);
    const existingWal = pendingEvents.find((event) => event.opId === bundle.event.opId) ?? null;
    const existingGitOid = gitBaseline.eventOids.get(bundle.event.opId);
    if (existingWal !== null || existingGitOid !== undefined) {
      const existing = existingWal ?? bundle.event;
      if (
        (existingWal !== null && walShadowCanonicalBytes(existingWal) !== walShadowCanonicalBytes(bundle.event)) ||
        (existingGitOid !== undefined &&
          existingGitOid !== localGitObjectRefStore.blobOid(walShadowCanonicalBytes(bundle.event)))
      )
        throw new TaskEventStoreError("op_conflict", `opId ${bundle.event.opId} already names different event bytes`);
      const priorPending = pendingEvents.filter((event) => event.workspaceRevision < existing.workspaceRevision);
      makeVisible(ledger, wal, priorPending, gitBaseline.files, bundle, options);
      return pendingReceipt(existing, gitHead?.revision ?? 0, git.currentCommit(), []);
    }
    const beforeRevision = records.at(-1)?.revision ?? gitHead?.revision ?? 0;
    if (bundle.event.workspaceRevision !== beforeRevision + 1)
      throw new TaskEventStoreError(
        "revision_conflict",
        `workspace revision ${bundle.event.workspaceRevision} must follow ${beforeRevision}`,
      );
    const started = localGitObjectRefStore.processCount();
    const publish = (): void => {
      options.beforeAppend?.();
      options.killpoint?.("before_event_write");
      // The killpoint models the gap in which a successor writer epoch can be
      // allocated. Recheck immediately before the WAL becomes authoritative.
      options.beforeAppend?.();
      wal.append({ event: bundle.event, blobs: bundle.blobs });
      options.killpoint?.("after_event_write");
      options.killpoint?.("after_head_write");
      makeVisible(ledger, wal, pendingEvents, gitBaseline.files, bundle, options);
    };
    if (options.withAppendFence) options.withAppendFence(publish);
    else publish();
    const changedPaths = [
      ...canonicalDocumentClaims(bundle.event).map((claim) => claim.path),
      ...canonicalDocumentRetirements(bundle.event).map((retirement) => retirement.path),
    ].sort();
    const receipt = pendingReceipt(
      bundle.event,
      gitHead?.revision ?? 0,
      git.currentCommit(),
      changedPaths,
      localGitObjectRefStore.processCount() - started,
    );
    scheduleFlush(true);
    return receipt;
  };
  const recover = (): EventRecoveryReceipt => {
    const started = performance.now();
    let recovered: EventRecoveryReceipt;
    try {
      recovered = git.recover();
      reloadGit();
      const records = wal.records();
      if (records.length > 0)
        materializeVisible(
          ledger,
          wal,
          records.map((record) => record.event),
          gitBaseline.files,
          git.currentCommit(),
          (sha256) => git.readContentBlob(sha256),
        );
    } catch (error) {
      consumeKnownError(error);
      return {
        status: "indeterminate",
        publications: 0,
        elapsedMs: performance.now() - started,
        error: walShadowErrorMessage(error),
        ...(error instanceof TaskEventStoreError ? { errorCode: error.code } : {}),
      };
    }
    consecutiveFailures = 0;
    const records = wal.records();
    const hadWalRecords = records.length > 0;
    const hadPendingPublication = (records.at(-1)?.revision ?? 0) > (gitHead?.revision ?? 0);
    if (!runFlush("recovery")) {
      scheduleRetry();
      return {
        status: "indeterminate",
        publications: 0,
        elapsedMs: performance.now() - started,
        error: lastFlushError ?? "WAL recovery materialization failed",
        errorCode: "publication_indeterminate",
      };
    }
    if (recovered.status !== "none" || !hadWalRecords) return recovered;
    return {
      status: hadPendingPublication ? "committed" : "already_committed",
      publications: hadPendingPublication ? 1 : 0,
      elapsedMs: performance.now() - started,
    };
  };
  const drain = async (): Promise<void> => {
    closed = true;
    clearSchedule();
    consecutiveFailures = 0;
    for (let attempt = 1; hasWalRecords() && attempt <= retryLimit; attempt += 1) {
      if (runFlush("drain") && !hasWalRecords()) break;
      if (attempt < retryLimit) await wait(retryBaseMs * 2 ** (attempt - 1));
    }
    if (hasWalRecords())
      throw new TaskEventStoreError(
        "publication_indeterminate",
        `WAL drain exhausted ${retryLimit} attempts with ${wal.records().length} record(s) still pending checkpoint`,
      );
  };
  return {
    canonicalRef: git.canonicalRef,
    currentCommit: () => git.currentCommit(),
    currentCut: () => canonicalLedgerCut(git.currentCommit().repoId, readHead()),
    publication: (event) => ({
      commitSha: event.workspaceRevision <= (gitHead?.revision ?? 0) ? git.currentCommit() : null,
      cut: canonicalEventCut(git.currentCommit().repoId, event),
    }),
    revisionAt: (commit) => git.revisionAt(commit),
    layout: () => gitLayout,
    read: stream,
    readHead,
    readEvent: (opId) =>
      wal.records().find((record) => record.opId === opId)?.event ??
      (gitBaseline.eventOids.has(opId) ? git.readEvent(opId) : null),
    readTaskEvent: (opId) => {
      const event =
        wal.records().find((record) => record.opId === opId)?.event ??
        (gitBaseline.eventOids.has(opId) ? git.readEvent(opId) : null);
      return event?.schema === "task-event/v1" ? event : null;
    },
    readBatch,
    readContentBlob: (sha256) => wal.readContentBlob(sha256) ?? git.readContentBlob(sha256),
    append,
    migrateLayout: (migration) => {
      if (!runFlush("layout migration"))
        throw new TaskEventStoreError("publication_indeterminate", "WAL must drain before a ledger layout migration");
      const receipt = git.migrateLayout(migration);
      reloadGit();
      return receipt;
    },
    recover,
    materialize: () =>
      materializeVisible(ledger, wal, stream().events, gitBaseline.files, git.currentCommit(), (sha256) =>
        git.readContentBlob(sha256),
      ),
    drain,
  };
}

function makeVisible(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  wal: WalEventLog,
  previous: CanonicalEventStreamV1["events"],
  committed: ReadonlyMap<string, GitBaselineNode>,
  bundle: CanonicalWriteBundle,
  options: StoreOptions,
): void {
  const priorClaims = latestDocumentClaims(previous);
  const writes = canonicalDocumentClaims(bundle.event).map((claim) => {
    const blob = bundle.blobs.find((candidate) => candidate.sha256 === claim.sha256);
    if (!blob) throw new TaskEventStoreError("invalid_write_plan", `authored file ${claim.path} has no content input`);
    const target = ledgerGitPath(ledger, claim.path);
    const physical = pathFor(ledger.rootDir, target);
    const local = localGitWorktreeSettlement.readNode(physical);
    if (local !== null && local.sha256 !== claim.sha256) {
      const prior = priorClaims.get(claim.path);
      const base = committed.get(target);
      const matchesPrior =
        prior === undefined
          ? base !== undefined && local.gitOid === base.oid && local.mode === base.mode
          : local.sha256 === prior.sha256 && local.mode === prior.mode;
      if (!matchesPrior)
        localGitWorktreeSettlement.preserveVisibleConflict(
          ledger.rootDir,
          physical,
          target,
          `${bundle.event.workspaceRevision}:${bundle.event.opId}`,
        );
    }
    return { target, body: blob.body, mode: canonicalDocumentMode(bundle.event, claim.path) };
  });
  localGitWorktreeSettlement.visible(ledger.rootDir, writes, {
    beforeRename: () => options.killpoint?.("before_worktree_rename"),
    afterRename: () => options.killpoint?.("after_worktree_rename"),
  });
  const deletions = canonicalDocumentRetirements(bundle.event).map((retirement) => {
    const target = ledgerGitPath(ledger, retirement.path),
      physical = pathFor(ledger.rootDir, target),
      local = localGitWorktreeSettlement.readNode(physical);
    if (local !== null && local.sha256 !== retirement.baseBlobSha256)
      localGitWorktreeSettlement.preserveVisibleConflict(
        ledger.rootDir,
        physical,
        target,
        `${bundle.event.workspaceRevision}:${bundle.event.opId}`,
      );
    return target;
  });
  localGitWorktreeSettlement.deleteVisible(ledger.rootDir, deletions, {
    beforeRename: () => options.killpoint?.("before_worktree_rename"),
    afterRename: () => options.killpoint?.("after_worktree_rename"),
  });
  for (const claim of canonicalDocumentClaims(bundle.event)) {
    const supplied = bundle.blobs.find((blob) => blob.sha256 === claim.sha256);
    if (wal.readContentBlob(claim.sha256) === null && supplied === undefined)
      throw new TaskEventStoreError("invalid_store", `visible document ${claim.sha256} is absent from the durable WAL`);
  }
}

function materializeVisible(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  wal: WalEventLog,
  events: CanonicalEventStreamV1["events"],
  committed: ReadonlyMap<string, GitBaselineNode>,
  commitSha: ReturnType<CanonicalEventStore["currentCommit"]>,
  readGitContent: (sha256: string) => Uint8Array | null,
): MaterializationReceipt {
  const latest = latestDocumentClaims(events);
  const changed: string[] = [];
  const conflicts: string[] = [];
  const writes: { target: string; body: string; mode: "100644" | "120000" }[] = [];
  for (const [logical, claim] of [...latest].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = wal.readContentBlob(claim.sha256) ?? readGitContent(claim.sha256);
    if (bytes === null) continue;
    const target = ledgerGitPath(ledger, logical);
    const physical = pathFor(ledger.rootDir, target);
    const local = localGitWorktreeSettlement.readNode(physical);
    if (local?.sha256 === claim.sha256 && local.mode === claim.mode) continue;
    const base = committed.get(target);
    if (local !== null && (base === undefined || local.gitOid !== base.oid || local.mode !== base.mode))
      conflicts.push(
        localGitWorktreeSettlement.preserveVisibleConflict(
          ledger.rootDir,
          physical,
          target,
          `${events.at(-1)?.workspaceRevision ?? 0}:${claim.sha256}`,
        ),
      );
    changed.push(logical);
    writes.push({ target, body: Buffer.from(bytes).toString("utf8"), mode: claim.mode });
  }
  localGitWorktreeSettlement.visible(ledger.rootDir, writes);
  return { status: "visible", commitSha, changed, conflicts };
}

function latestDocumentClaims(
  events: CanonicalEventStreamV1["events"],
): Map<string, { sha256: string; mode: "100644" | "120000" }> {
  const latest = new Map<string, { sha256: string; mode: "100644" | "120000" }>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) latest.delete(retirement.path);
    for (const claim of canonicalDocumentClaims(event))
      latest.set(claim.path, { sha256: claim.sha256, mode: canonicalDocumentMode(event, claim.path) });
  }
  return latest;
}

function mergeStream(git: CanonicalEventStreamV1, records: readonly WalEventRecord[]): CanonicalEventStreamV1 {
  const events = git.events.slice();
  for (const record of records) {
    const index = record.revision - 1;
    if (index < events.length) {
      if (walShadowCanonicalBytes(events[index]!) !== walShadowCanonicalBytes(record.event))
        throw new TaskEventStoreError("invalid_store", `WAL revision ${record.revision} differs from Git`);
    } else if (index === events.length) events.push(record.event);
    else throw new TaskEventStoreError("invalid_store", `WAL revision ${record.revision} leaves a gap`);
  }
  return { schema: "canonical-event-stream/v1", revision: events.length, events };
}

function pendingReceipt(
  event: CanonicalWriteBundle["event"],
  gitRevision: number,
  gitCommit: ReturnType<CanonicalEventStore["currentCommit"]>,
  changedPaths: readonly string[],
  gitProcesses = 0,
): CanonicalEventAppendReceipt {
  return {
    status: "applied",
    event,
    revision: event.workspaceRevision,
    commitSha: event.workspaceRevision <= gitRevision ? gitCommit : null,
    cut: canonicalEventCut(gitCommit.repoId, event),
    metrics: { gitProcesses, nodeSyncs: 0, changedPaths },
  };
}

interface GitBaselineNode {
  readonly mode: "100644" | "120000";
  readonly oid: string;
}

interface GitBaseline {
  readonly eventOids: ReadonlyMap<string, string>;
  readonly files: ReadonlyMap<string, GitBaselineNode>;
}

function readGitBaseline(ledger: ReturnType<typeof resolveLedgerGitLayout>, commit: string): GitBaseline {
  const entries = localGitObjectRefStore.listTree(ledger.rootDir, commit, ledger.authoredPrefix || undefined);
  const files = new Map(entries.map(({ target, mode, oid }) => [target, { mode, oid }] as const));
  const eventOids = new Map<string, string>();
  const prefix = ledgerGitPath(ledger, "events/");
  for (const { target, oid } of entries) {
    if (!target.startsWith(prefix) || target.endsWith("/head.json") || target === `${prefix}head.json`) continue;
    const relative = target.slice(prefix.length);
    const name = relative.includes("/") ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
    if (name.endsWith(".json")) eventOids.set(name.slice(0, -5), oid);
  }
  return { eventOids, files };
}

function cursorNames(event: CanonicalWriteBundle["event"]): readonly string[] {
  return [
    event.opId,
    eventObjectRelativePath(event.opId, "flat/v1"),
    eventObjectRelativePath(event.opId, "sharded-sha256-2/v1"),
  ];
}

function eventHead(event: CanonicalWriteBundle["event"]): EventHead {
  return {
    revision: event.workspaceRevision,
    opId: event.opId,
    eventDigest: `sha256:${sha256Text(walShadowCanonicalBytes(event))}`,
  };
}

function pathFor(repoRoot: string, target: string): string {
  return [repoRoot, ...target.split("/")].join("/");
}

function walShadowCanonicalBytes(event: CanonicalWriteBundle["event"]): string {
  return serializeCanonicalEvent(event);
}

function positive(explicit: number | undefined, envName: string, fallback: number): number {
  const value = explicit ?? Number.parseInt(process.env[envName] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function walShadowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
