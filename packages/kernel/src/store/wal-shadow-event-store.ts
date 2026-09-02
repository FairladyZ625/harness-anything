import { serializePersistedCanonicalEvent } from "../domain/doc-sync.contract.ts";
import { normalizeContentAddressedInputs, type ActorIdentity, type EventHead } from "../domain/write-chain.contract.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { DEFAULT_WAL_FLUSH_SETTINGS } from "../domain/settings.ts";
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
  type MaterializationFailureReason,
  type MaterializationHealth,
  type PublicationFile,
  validateCanonicalWriteBundle,
} from "./task-event-store.ts";
import {
  captureWalDurableCut,
  openWalEventLog,
  type WalDurableCutDescriptor,
  type WalEventLog,
  type WalEventRecord,
} from "./wal-event-log.ts";
import { WalMaterializerDivergedError } from "./wal-git-materializer.ts";
import type {
  WalBaselineDeltaV1,
  WalMaterializationFenceV1,
  WalMaterializationFailureV1,
  WalMaterializationSuccessV1,
} from "./wal-materialization-protocol.ts";
import { isRetryableWalMaterializationError, runWalMaterializationRequest } from "./wal-materialization-worker.ts";
import type { WalMaterializationRequestV1, WalMaterializationResponseV1 } from "./wal-materialization-protocol.ts";

export { canonicalDocumentClaims, canonicalEventWritePlan, TaskEventStoreError };

// Retry transient Git locks/resource pressure for ~32s before imposing fail-closed recovery cost.
const DEFAULT_RETRY_LIMIT = 8;
const DEFAULT_RETRY_BASE_MS = 250;

export interface WalFlushPolicy {
  readonly adaptive: boolean;
  readonly events: number;
  readonly bytes: number;
  readonly milliseconds: number;
}

type StoreOptions = Parameters<typeof makeGitEventStore>[0] & {
  /** Observational overlays reparse WAL bytes but cannot append, recover, flush, or checkpoint. */
  readonly mutable?: boolean;
  readonly walFlushEvents?: number;
  readonly walFlushBytes?: number;
  readonly walFlushMs?: number;
  readonly walFlushAdaptive?: boolean;
  readonly walFlushPolicy?: () => Partial<WalFlushPolicy>;
  readonly walRetryLimit?: number;
  readonly walRetryBaseMs?: number;
  /** Runs after a WAL cut is durable and Git state has been reloaded. */
  readonly afterFlush?: (actor: ActorIdentity, inventory: unknown | null) => void | Promise<void>;
  /** Executes materialization in the RepoWriterCell that owns this WAL. */
  readonly walMaterialize?: (
    config: import("./wal-materialization-protocol.ts").WalMaterializationWorkerConfig,
    request: WalMaterializationRequestV1,
  ) => WalMaterializationResponseV1 | Promise<WalMaterializationResponseV1>;
  readonly walMaterializationFence?: () => WalMaterializationFenceV1 | null;
  readonly walMaterializationSpan?: (span: {
    readonly name: "materialization" | "fingerprint";
    readonly durationMs: number;
    readonly throughRevision: number;
  }) => void;
  /** Publishes health changes through the owning writer cell's existing status channel. */
  readonly onMaterializationHealthChange?: (health: MaterializationHealth) => void;
  readonly walMaterializationTestFault?: {
    readonly point: "before_materialization" | "worker_exit" | "after_git_commit" | "after_git_ref_update";
    readonly failures: number;
  };
};

export function makeWalShadowEventStore(options: StoreOptions): CanonicalEventStore {
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("canonical event store requires rootInput or rootDir");
  const rootDir = resolveHarnessLayout(input).rootDir;
  const ledger = resolveLedgerGitLayout(input);
  // Git content through this revision was validated in this process. Materialization
  // rechecks WAL object bytes before this watermark can advance across a flushed suffix.
  let contentValidatedThrough = 0;
  const gitOptions = {
    ...options,
    beforeAppend: undefined,
    withAppendFence: undefined,
    contentValidationFloor: () => contentValidatedThrough,
  };
  let git = makeGitEventStore(gitOptions);
  let gitHead = git.readHead();
  let gitLayout = git.layout();
  let gitBaseline = readGitBaseline(ledger, git.currentCommit().sha);
  let gitStream: CanonicalEventStreamV1 | null = null;
  let mergedStream: CanonicalEventStreamV1 | null = null;
  const mutable = options.mutable !== false;
  const wal = openWalEventLog(rootDir, { mutable });
  const materializationConfig = {
    schema: "harness-wal-materialization-worker/v1",
    repoId: options.repoId,
    rootDir,
    ...(options.authoredBranch ? { authoredBranch: options.authoredBranch } : {}),
  } as const;
  const materialize = options.walMaterialize ?? runWalMaterializationRequest;
  const retryLimit = positive(options.walRetryLimit, "HARNESS_WAL_RETRY_LIMIT", DEFAULT_RETRY_LIMIT);
  const retryBaseMs = positive(options.walRetryBaseMs, "HARNESS_WAL_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediate: ReturnType<typeof setImmediate> | null = null;
  let consecutiveFailures = 0;
  let lastFlushError: string | null = null;
  let failureLatch: { readonly reason: MaterializationFailureReason; readonly lastError: string } | null = null;
  let lastCheckpointAt =
    gitHead === null ? null : localGitObjectRefStore.commitTimestamp(ledger.rootDir, git.currentCommit().sha);
  let lastSettlementFingerprint: string | null = null;
  let pendingWalRecords = wal.records().filter((record) => record.revision > (gitHead?.revision ?? 0));
  let walByOpId = new Map(wal.records().map((record) => [record.opId, record.event] as const));
  let latestPendingClaims = latestDocumentClaims(pendingWalRecords.map((record) => record.event));
  let bulkWriteActive = false;
  let appendRatePerSecond = 0;
  let lastAppendAt = 0;
  let lastFlushDurationMs = 0;
  let configuredFlushPolicy = options.walFlushPolicy?.() ?? {};
  let closed = false;
  let inFlightFlush: Promise<boolean> | null = null;
  let coalescedFlush: { readonly context: string; readonly compactWorktree: boolean } | null = null;
  let remainingTestFaults = options.walMaterializationTestFault?.failures ?? 0;
  let recoveryMaterializationPending = false;
  let pendingMaterializationFence: WalMaterializationFenceV1 | null = null;
  const settlementFutures = new Set<Promise<void>>();

  const reloadGit = (advancedBaseline?: GitBaseline): void => {
    git = makeGitEventStore(gitOptions);
    gitHead = git.readHead();
    lastCheckpointAt =
      gitHead === null ? null : localGitObjectRefStore.commitTimestamp(ledger.rootDir, git.currentCommit().sha);
    gitLayout = git.layout();
    gitBaseline = advancedBaseline ?? readGitBaseline(ledger, git.currentCommit().sha);
    gitStream = null;
    mergedStream = null;
    pendingWalRecords = wal.records().filter((record) => record.revision > (gitHead?.revision ?? 0));
    walByOpId = new Map(wal.records().map((record) => [record.opId, record.event] as const));
    latestPendingClaims = latestDocumentClaims(pendingWalRecords.map((record) => record.event));
  };
  const readGitStream = (): CanonicalEventStreamV1 => {
    gitStream ??= git.read();
    contentValidatedThrough = Math.max(contentValidatedThrough, gitHead?.revision ?? 0);
    return gitStream;
  };
  const stream = (): CanonicalEventStreamV1 => (mergedStream ??= mergeStream(readGitStream(), wal.records()));
  const pendingCount = (): number => pendingWalRecords.length;
  const hasWalRecords = (): boolean => wal.records().length > 0;
  const materializationHealth = (): MaterializationHealth => ({
    state: failureLatch !== null ? "failed" : consecutiveFailures > 0 ? "retrying" : "ok",
    lastCheckpointRevision: gitHead?.revision ?? 0,
    lastCheckpointAt,
    pendingWalEvents: pendingCount(),
    ...(failureLatch ? { reason: failureLatch.reason, lastError: failureLatch.lastError } : {}),
    ...(failureLatch === null && lastFlushError !== null ? { lastError: lastFlushError } : {}),
  });
  const notifyHealthChange = (): void => {
    try {
      options.onMaterializationHealthChange?.(materializationHealth());
    } catch (error) {
      console.warn(`[wal-materializer] materialization health publication failed: ${walShadowErrorMessage(error)}`);
      consumeKnownError(error);
    }
  };
  const latchMaterializationFailure = (reason: MaterializationFailureReason, error: unknown): void => {
    lastFlushError = walShadowErrorMessage(error);
    failureLatch = { reason, lastError: lastFlushError };
    clearSchedule();
    notifyHealthChange();
  };
  const materializationFailedError = (): TaskEventStoreError => {
    const health = materializationHealth();
    if (health.state !== "failed" || health.reason === undefined || health.lastError === undefined)
      throw new TaskEventStoreError("invalid_store", "materialization failure latch has no failure details");
    const data = {
      lastCheckpointRevision: health.lastCheckpointRevision,
      lastCheckpointAt: health.lastCheckpointAt,
      pendingWalEvents: health.pendingWalEvents,
      reason: health.reason,
      lastError: health.lastError,
    } as const;
    return Object.assign(
      new TaskEventStoreError(
        "materialization_failed",
        `Git materialization is latched after ${health.reason}; recover the repository before writing again`,
      ),
      { ...data, data, diagnostic: { kind: "materialization-failed", ...data } as const },
    );
  };
  const assertMaterializationWritable = (): void => {
    if (failureLatch !== null) throw materializationFailedError();
  };
  const flushPolicy = (): WalFlushPolicy => {
    const configured = configuredFlushPolicy;
    return {
      adaptive: booleanOverride(
        "HARNESS_WAL_FLUSH_ADAPTIVE",
        options.walFlushAdaptive ?? configured.adaptive ?? DEFAULT_WAL_FLUSH_SETTINGS.adaptive,
      ),
      events: positiveOverride(
        "HARNESS_WAL_FLUSH_EVENTS",
        options.walFlushEvents ?? configured.events ?? DEFAULT_WAL_FLUSH_SETTINGS.events,
      ),
      bytes: positiveOverride(
        "HARNESS_WAL_FLUSH_BYTES",
        options.walFlushBytes ?? configured.bytes ?? DEFAULT_WAL_FLUSH_SETTINGS.bytes,
      ),
      milliseconds: positiveOverride(
        "HARNESS_WAL_FLUSH_MS",
        options.walFlushMs ?? configured.milliseconds ?? DEFAULT_WAL_FLUSH_SETTINGS.milliseconds,
      ),
    };
  };
  const effectiveEventThreshold = (policy: WalFlushPolicy): number => {
    if (!policy.adaptive || appendRatePerSecond <= 0) return policy.events;
    const amortizationWindow = Math.max(policy.milliseconds, lastFlushDurationMs * 4);
    const loadBatch = Math.ceil((appendRatePerSecond * amortizationWindow) / 1_000);
    return Math.min(Math.max(policy.events, loadBatch), policy.events * 16);
  };
  const clearSchedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    if (immediate !== null) clearImmediate(immediate);
    timer = null;
    immediate = null;
  };
  const publicationRefs = (): { readonly canonical: string | null; readonly authored: string | null } | null => {
    const branch = options.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
    if (!branch) return null;
    const refs = new Map(
      localGitObjectRefStore
        .listRefs(ledger.rootDir, ["refs/ha/canonical", `refs/heads/${branch}`])
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          const [ref, sha] = line.split(" ");
          return [ref!, sha!] as const;
        }),
    );
    return { canonical: refs.get("refs/ha/canonical") ?? null, authored: refs.get(`refs/heads/${branch}`) ?? null };
  };
  const repairedDivergence = (): boolean => {
    if (failureLatch?.reason !== "git_diverged") return true;
    let refs: ReturnType<typeof publicationRefs>;
    try {
      refs = publicationRefs();
    } catch (error) {
      consumeKnownError(error);
      return false;
    }
    if (refs === null || refs.canonical === null || refs.authored === null || refs.canonical !== refs.authored)
      return false;
    try {
      reloadGit();
    } catch (error) {
      consumeKnownError(error);
      return false;
    }
    return true;
  };
  const reportSpan = (name: "materialization" | "fingerprint", durationMs: number, throughRevision: number): void => {
    options.walMaterializationSpan?.({ name, durationMs, throughRevision });
  };
  const trackSettlement = (intent: WalMaterializationSuccessV1["settlementIntent"]): void => {
    if (!intent || !options.afterFlush) return;
    const observed = Promise.resolve()
      .then(() => options.afterFlush!(intent.actor, intent.inventory))
      .catch((error) => {
        console.warn(`[wal-materializer] authored settlement failed: ${walShadowErrorMessage(error)}`);
        consumeKnownError(error);
      })
      .finally(() => settlementFutures.delete(observed));
    settlementFutures.add(observed);
  };
  const applyBaselineDelta = (delta: WalBaselineDeltaV1): void => {
    const eventOids = gitBaseline.eventOids as Map<string, string>,
      files = gitBaseline.files as Map<string, GitBaselineNode>;
    for (const event of delta.events) eventOids.set(event.opId, event.oid);
    for (const file of delta.files)
      if ("delete" in file) files.delete(file.delete);
      else files.set(file.target, { mode: file.mode, oid: file.oid });
  };
  const acceptMaterializedCut = (
    requestCut: WalDurableCutDescriptor,
    response: WalMaterializationSuccessV1,
    gitRevisionBeforeFlush: number,
  ): void => {
    const durableRecord = wal.records().find((record) => record.revision === requestCut.throughRevision);
    if (
      response.cut.throughRevision !== requestCut.throughRevision ||
      response.cut.lastOffset !== requestCut.lastOffset ||
      response.cut.headDigest !== requestCut.headDigest ||
      response.git.head?.revision !== requestCut.throughRevision ||
      response.git.head.eventDigest !== requestCut.headDigest ||
      response.git.head.opId !== durableRecord?.opId ||
      !/^[0-9a-f]{40}$/u.test(response.git.commitSha)
    )
      throw new TaskEventStoreError("invalid_store", "worker returned a materialization receipt for the wrong WAL cut");
    // Materialization and destructive checkpoint execute in this RepoWriterCell
    // against its one mutable WalEventLog owner.
    wal.checkpointCut(requestCut);
    git.acceptMaterializedCut(response.git);
    gitHead = response.git.head;
    gitLayout = response.git.layout;
    applyBaselineDelta(response.baselineDelta);
    gitStream = null;
    mergedStream = null;
    pendingWalRecords = wal.records().filter((record) => record.revision > (gitHead?.revision ?? 0));
    walByOpId = new Map(wal.records().map((record) => [record.opId, record.event] as const));
    latestPendingClaims = latestDocumentClaims(pendingWalRecords.map((record) => record.event));
    if (pendingWalRecords.length === 0) pendingMaterializationFence = null;
    if (contentValidatedThrough >= gitRevisionBeforeFlush)
      contentValidatedThrough = Math.max(contentValidatedThrough, response.git.head.revision);
    lastFlushDurationMs = response.spans.materializationMs;
    lastSettlementFingerprint = response.settlementFingerprint;
    lastCheckpointAt = durableRecord?.event.occurredAt ?? null;
    reportSpan("materialization", response.spans.materializationMs, requestCut.throughRevision);
    reportSpan("fingerprint", response.spans.fingerprintMs, requestCut.throughRevision);
    trackSettlement(response.settlementIntent);
  };
  const materializationError = (failure: WalMaterializationFailureV1): Error => {
    if (failure.error.diverged)
      return new WalMaterializerDivergedError(
        ledger.rootDir,
        `refs/heads/${options.authoredBranch ?? "HEAD"}`,
        failure.error.canonicalSha ?? git.currentCommit().sha,
      );
    return new TaskEventStoreError(
      failure.error.code === "invalid_store" ? "invalid_store" : "publication_indeterminate",
      failure.error.message,
    );
  };
  const executeFlush = async (context: string, compactWorktree: boolean): Promise<boolean> => {
    if (failureLatch !== null) return false;
    const cut = captureWalDurableCut(wal);
    if (cut === null) return true;
    const first = wal.records()[0]?.revision ?? cut.throughRevision,
      gitRevisionBeforeFlush = gitHead?.revision ?? 0,
      fault =
        remainingTestFaults > 0 && options.walMaterializationTestFault
          ? { point: options.walMaterializationTestFault.point }
          : undefined;
    if (fault) remainingTestFaults -= 1;
    let responseRetryable: boolean | undefined;
    try {
      const response = await materialize(materializationConfig, {
        schema: "harness-wal-materialization-request/v1",
        requestId: randomUUID(),
        cut,
        expectedGit: {
          revision: gitRevisionBeforeFlush,
          commitSha: git.currentCommit().sha,
          layout: gitLayout,
        },
        context,
        compactWorktree,
        previousSettlementFingerprint: lastSettlementFingerprint,
        fence: pendingMaterializationFence,
        ...(fault ? { testFault: fault } : {}),
      });
      if (response.outcome === "failed") {
        responseRetryable = response.error.retryable;
        throw materializationError(response);
      }
      acceptMaterializedCut(cut, response, gitRevisionBeforeFlush);
      const range = `${first}-${cut.throughRevision}`;
      const attempt = consecutiveFailures + 1;
      console.info(`[wal-materializer] materialized revisions ${range} (${context}, attempt ${attempt})`);
      consecutiveFailures = 0;
      lastFlushError = null;
      failureLatch = null;
      notifyHealthChange();
      return true;
    } catch (error) {
      if (error instanceof WalMaterializerDivergedError) {
        latchMaterializationFailure("git_diverged", error);
        console.error(`[wal-materializer] diverged; materializer stopped: ${error.message}`);
        consumeKnownError(error);
        return false;
      }
      if (!(responseRetryable ?? isRetryableWalMaterializationError(error))) {
        latchMaterializationFailure("deterministic_failure", error);
        console.error(
          `[wal-materializer] deterministic failure; materializer stopped: ${walShadowErrorMessage(error)}`,
        );
        consumeKnownError(error);
        return false;
      }
      consecutiveFailures += 1;
      lastFlushError = walShadowErrorMessage(error);
      const failedAttempt = `${consecutiveFailures}/${retryLimit}`;
      console.warn(
        `[wal-materializer] materialization failed (${context}, attempt ${failedAttempt}); ` +
          `acknowledged WAL writes remain valid: ${lastFlushError}`,
      );
      if (consecutiveFailures >= retryLimit) latchMaterializationFailure("retry_budget_exhausted", error);
      else notifyHealthChange();
      consumeKnownError(error);
      return false;
    }
  };
  const queueFlush = (context: string, compactWorktree = false): Promise<boolean> => {
    clearSchedule();
    coalescedFlush = {
      context,
      compactWorktree: compactWorktree || (coalescedFlush?.compactWorktree ?? false),
    };
    if (inFlightFlush) return inFlightFlush;
    const pump = async (): Promise<boolean> => {
      let succeeded = true;
      while (coalescedFlush !== null) {
        const request = coalescedFlush;
        coalescedFlush = null;
        if (!hasWalRecords()) continue;
        if (!(await executeFlush(request.context, request.compactWorktree))) {
          succeeded = false;
          break;
        }
      }
      return succeeded;
    };
    inFlightFlush = pump().then(
      (succeeded) => {
        inFlightFlush = null;
        // afterFlush can append while the pump is leaving its loop. In that window
        // scheduleFlush observes the old promise and coalesces the request after the
        // loop has already checked it, so explicitly hand the late request to a new
        // pump before releasing this turn.
        if (succeeded && coalescedFlush !== null)
          void queueFlush(coalescedFlush.context, coalescedFlush.compactWorktree).then((settled) => {
            if (!settled) scheduleRetry();
          });
        return succeeded;
      },
      (error: unknown) => {
        inFlightFlush = null;
        throw error;
      },
    );
    return inFlightFlush;
  };
  const scheduleRetry = (): void => {
    if (closed || failureLatch !== null || !hasWalRecords()) return;
    const delay = retryBaseMs * 2 ** Math.max(0, consecutiveFailures - 1);
    timer = setTimeout(() => {
      timer = null;
      void queueFlush("retry").then((succeeded) => {
        if (!succeeded) scheduleRetry();
      });
    }, delay);
    timer.unref?.();
  };
  const scheduleFlush = (): void => {
    if (closed || bulkWriteActive || failureLatch !== null || !hasWalRecords()) return;
    const policy = flushPolicy(),
      threshold = effectiveEventThreshold(policy),
      thresholdReached = pendingCount() >= threshold || wal.head().lastOffset >= policy.bytes;
    if (inFlightFlush) {
      coalescedFlush = { context: "coalesced", compactWorktree: false };
      return;
    }
    if (timer !== null || immediate !== null) {
      if (!thresholdReached || immediate !== null) return;
      clearSchedule();
    }
    if (thresholdReached) {
      immediate = setImmediate(() => {
        immediate = null;
        void queueFlush("batch threshold").then((succeeded) => {
          if (!succeeded) scheduleRetry();
        });
      });
      immediate.unref();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void queueFlush("batch age").then((succeeded) => {
        if (!succeeded) scheduleRetry();
      });
    }, policy.milliseconds);
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
  const append = (
    bundle: CanonicalWriteBundle,
    additionalFiles: readonly PublicationFile[] = [],
  ): CanonicalEventAppendReceipt => {
    assertMutableStore();
    assertMaterializationWritable();
    if (additionalFiles.length > 0 || (bundle.preceding?.length ?? 0) > 0) {
      if (hasWalRecords()) {
        scheduleFlush();
        throw new TaskEventStoreError("publication_indeterminate", "WAL must drain before an atomic ledger rewrite");
      }
      const receipt = git.append(bundle, additionalFiles);
      reloadGit();
      // An atomic ledger rewrite rebuilds history through the validating Git publication
      // path; drop the floor so subsequent reads reverify the rewritten ledger.
      contentValidatedThrough = 0;
      trackSettlement({
        schema: "harness-doc-settlement-intent/v1",
        actor: bundle.event.actor,
        fingerprint: `atomic:${bundle.event.workspaceRevision}:${bundle.event.opId}`,
        inventory: null,
      });
      return receipt;
    }
    validateCanonicalWriteBundle(bundle);
    const existingWal = walByOpId.get(bundle.event.opId) ?? null;
    const existingGitOid = gitBaseline.eventOids.get(bundle.event.opId);
    if (existingWal !== null || existingGitOid !== undefined) {
      const existing = existingWal ?? bundle.event;
      if (
        (existingWal !== null && walShadowCanonicalBytes(existingWal) !== walShadowCanonicalBytes(bundle.event)) ||
        (existingGitOid !== undefined &&
          existingGitOid !== localGitObjectRefStore.blobOid(walShadowCanonicalBytes(bundle.event)))
      )
        throw new TaskEventStoreError("op_conflict", `opId ${bundle.event.opId} already names different event bytes`);
      const priorPending = pendingWalRecords
        .map((record) => record.event)
        .filter((event) => event.workspaceRevision < existing.workspaceRevision);
      makeVisible(ledger, wal, latestDocumentClaims(priorPending), gitBaseline.files, bundle, options);
      return pendingReceipt(existing, gitHead?.revision ?? 0, git.currentCommit(), []);
    }
    const beforeRevision = pendingWalRecords.at(-1)?.revision ?? gitHead?.revision ?? 0;
    if (bundle.event.workspaceRevision !== beforeRevision + 1)
      throw new TaskEventStoreError(
        "revision_conflict",
        `workspace revision ${bundle.event.workspaceRevision} must follow ${beforeRevision}`,
      );
    const started = localGitObjectRefStore.processCount();
    const priorClaims = latestPendingClaims;
    const publish = (): void => {
      options.beforeAppend?.();
      options.killpoint?.("before_event_write");
      // The killpoint models the gap in which a successor writer epoch can be
      // allocated. Recheck immediately before the WAL becomes authoritative.
      options.beforeAppend?.();
      const appendedRecord = wal.append({ event: bundle.event, blobs: normalizeContentAddressedInputs(bundle.blobs) });
      pendingWalRecords.push(appendedRecord);
      walByOpId.set(bundle.event.opId, bundle.event);
      latestPendingClaims = applyDocumentClaims(new Map(latestPendingClaims), bundle.event);
      notifyHealthChange();
      if (mergedStream !== null) {
        if (mergedStream === gitStream)
          mergedStream = { ...mergedStream, events: [...mergedStream.events, bundle.event] };
        else (mergedStream.events as CanonicalWriteBundle["event"][]).push(bundle.event);
        mergedStream = { ...mergedStream, revision: bundle.event.workspaceRevision };
      }
      options.killpoint?.("after_event_write");
      options.killpoint?.("after_head_write");
      if (!bulkWriteActive) makeVisible(ledger, wal, priorClaims, gitBaseline.files, bundle, options);
    };
    // Capture the finalize fence before any post-append killpoint can escape.
    // Once WAL append is durable, every later Git finalize must carry it even
    // if this request never reaches its normal receipt path.
    pendingMaterializationFence = options.walMaterializationFence?.() ?? null;
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
    scheduleFlush();
    const appendedAt = performance.now();
    if (lastAppendAt > 0) {
      const instantRate = 1_000 / Math.max(0.01, appendedAt - lastAppendAt);
      appendRatePerSecond = appendRatePerSecond === 0 ? instantRate : appendRatePerSecond * 0.8 + instantRate * 0.2;
    }
    lastAppendAt = appendedAt;
    return receipt;
  };
  const recover = (): EventRecoveryReceipt => {
    const started = performance.now();
    // Recovery is the full audit entry point: forget any in-process validation floor so the
    // next read revalidates every content claim in the ledger from scratch.
    contentValidatedThrough = 0;
    if (!repairedDivergence())
      return {
        status: "indeterminate",
        publications: 0,
        elapsedMs: performance.now() - started,
        error: failureLatch?.lastError ?? "WAL materializer remains stopped until Git refs are repaired",
        errorCode: "publication_indeterminate",
      };
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
    failureLatch = null;
    consecutiveFailures = 0;
    lastFlushError = null;
    notifyHealthChange();
    const records = wal.records();
    const hadWalRecords = records.length > 0;
    const hadPendingPublication = (records.at(-1)?.revision ?? 0) > (gitHead?.revision ?? 0);
    if (hadWalRecords) {
      recoveryMaterializationPending = true;
      scheduleFlush();
    }
    if (recovered.status !== "none" || !hadWalRecords) return recovered;
    return {
      status: hadPendingPublication ? "committed" : "already_committed",
      publications: hadPendingPublication ? 1 : 0,
      elapsedMs: performance.now() - started,
    } as const;
  };
  const drain = async (): Promise<void> => {
    closed = true;
    clearSchedule();
    if (!mutable) {
      wal.close();
      return;
    }
    try {
      if (failureLatch !== null && recover().status === "indeterminate") throw materializationFailedError();
      let attempt = 1;
      while (hasWalRecords() || settlementFutures.size > 0) {
        if (hasWalRecords()) {
          const succeeded = await queueFlush("drain");
          if (!succeeded && hasWalRecords()) {
            if (failureLatch !== null) throw materializationFailedError();
            if (attempt >= retryLimit)
              throw new TaskEventStoreError(
                "publication_indeterminate",
                `WAL drain exhausted ${retryLimit} attempts ` +
                  `with ${wal.records().length} record(s) still pending checkpoint`,
              );
            await wait(retryBaseMs * 2 ** (attempt - 1));
            attempt += 1;
            continue;
          }
          attempt = 1;
        }
        if (settlementFutures.size > 0) await Promise.all([...settlementFutures]);
      }
    } finally {
      wal.close();
    }
  };
  const flushPending = async (context: string, compactWorktree = false): Promise<void> => {
    assertMutableStore();
    clearSchedule();
    if (failureLatch !== null && recover().status === "indeterminate") throw materializationFailedError();
    clearSchedule();
    for (let attempt = 1; hasWalRecords() && attempt <= retryLimit; attempt += 1) {
      if ((await queueFlush(context, compactWorktree)) && !hasWalRecords()) return;
      if (failureLatch !== null) throw materializationFailedError();
      if (attempt < retryLimit) await wait(retryBaseMs * 2 ** (attempt - 1));
    }
    if (hasWalRecords())
      throw new TaskEventStoreError(
        "publication_indeterminate",
        `WAL ${context} exhausted ${retryLimit} attempts ` +
          `with ${wal.records().length} record(s) still pending checkpoint`,
      );
  };
  const beginBulkWrite = (): { readonly finish: () => Promise<void> } => {
    assertMutableStore();
    assertMaterializationWritable();
    if (closed || bulkWriteActive) throw new TaskEventStoreError("invalid_store", "a WAL bulk write is already active");
    bulkWriteActive = true;
    clearSchedule();
    const baseline = new Map(gitBaseline.files),
      firstRevision = (gitHead?.revision ?? 0) + 1;
    let finished = false;
    return {
      finish: async () => {
        if (finished) return;
        finished = true;
        const batch = wal.records().filter((record) => record.revision >= firstRevision);
        try {
          if (batch.length > 0)
            materializeVisible(
              ledger,
              wal,
              batch.map((record) => record.event),
              baseline,
              git.currentCommit(),
              (sha256) => git.readContentBlob(sha256),
            );
          await yieldToEventLoop();
          await flushPending("bulk write", true);
        } finally {
          bulkWriteActive = false;
        }
      },
    };
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
    readEvent: (opId) => walByOpId.get(opId) ?? (gitBaseline.eventOids.has(opId) ? git.readEvent(opId) : null),
    readTaskEvent: (opId) => {
      const event = walByOpId.get(opId) ?? (gitBaseline.eventOids.has(opId) ? git.readEvent(opId) : null);
      return event?.schema === "task-event/v1" ? event : null;
    },
    readBatch,
    readContentBlob: (sha256) => wal.readContentBlob(sha256) ?? git.readContentBlob(sha256),
    materializationHealth,
    append,
    migrateLayout: (migration) => {
      assertMutableStore();
      assertMaterializationWritable();
      if (hasWalRecords()) {
        scheduleFlush();
        throw new TaskEventStoreError("publication_indeterminate", "WAL must drain before a ledger layout migration");
      }
      const receipt = git.migrateLayout(migration);
      reloadGit();
      contentValidatedThrough = 0;
      return receipt;
    },
    recover: () => {
      assertMutableStore();
      return recover();
    },
    materialize: () => {
      assertMutableStore();
      return materializeVisible(ledger, wal, stream().events, gitBaseline.files, git.currentCommit(), (sha256) =>
        git.readContentBlob(sha256),
      );
    },
    beginBulkWrite,
    settlePendingMaterialization: flushPending,
    configureWalFlushPolicy: (policy) => {
      assertMutableStore();
      configuredFlushPolicy = policy;
      clearSchedule();
      scheduleFlush();
    },
    settleRecoveryMaterialization: async () => {
      assertMutableStore();
      if (!recoveryMaterializationPending) return;
      await flushPending("recovery receipt");
      recoveryMaterializationPending = false;
    },
    drain,
  };

  function assertMutableStore(): void {
    if (!mutable) throw new TaskEventStoreError("invalid_store", "observational WAL stores are immutable");
  }
}

export function makeWalShadowEventReader(options: Omit<StoreOptions, "mutable">): CanonicalEventStore {
  return makeWalShadowEventStore({ ...options, mutable: false });
}

function makeVisible(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  wal: WalEventLog,
  priorClaims: ReadonlyMap<string, { sha256: string; mode: "100644" | "120000" }>,
  committed: ReadonlyMap<string, GitBaselineNode>,
  bundle: CanonicalWriteBundle,
  options: StoreOptions,
): void {
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
    const target = ledgerGitPath(ledger, logical);
    const physical = pathFor(ledger.rootDir, target);
    const local = localGitWorktreeSettlement.readNode(physical);
    // Decide divergence from the worktree hash and the in-memory claim alone; an already-materialized
    // document is skipped before any canonical blob is read. This keeps materialize proportional to the
    // number of divergent files, not the size of the whole corpus: a current worktree reads zero blobs
    // (previously every document forced a `git show`, which wedged the daemon event loop at scale).
    if (local?.sha256 === claim.sha256 && local.mode === claim.mode) continue;
    const bytes = wal.readContentBlob(claim.sha256) ?? readGitContent(claim.sha256);
    if (bytes === null) continue;
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

function applyDocumentClaims(
  latest: Map<string, { sha256: string; mode: "100644" | "120000" }>,
  event: CanonicalWriteBundle["event"],
): Map<string, { sha256: string; mode: "100644" | "120000" }> {
  for (const retirement of canonicalDocumentRetirements(event)) latest.delete(retirement.path);
  for (const claim of canonicalDocumentClaims(event))
    latest.set(claim.path, { sha256: claim.sha256, mode: canonicalDocumentMode(event, claim.path) });
  return latest;
}

function mergeStream(git: CanonicalEventStreamV1, records: readonly WalEventRecord[]): CanonicalEventStreamV1 {
  if (records.length === 0) return git;
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
  return serializePersistedCanonicalEvent(event);
}

function positive(explicit: number | undefined, envName: string, fallback: number): number {
  const value = explicit ?? Number.parseInt(process.env[envName] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveOverride(envName: string, fallback: number): number {
  const value = Number.parseInt(process.env[envName] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function booleanOverride(envName: string, fallback: boolean): boolean {
  const value = process.env[envName];
  return value === "true" ? true : value === "false" ? false : fallback;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function walShadowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
import { randomUUID } from "node:crypto";
