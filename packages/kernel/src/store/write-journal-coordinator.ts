import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type {
  FlushReason,
  FlushReport,
  RecoveryReport,
  WriteAck,
  WriteCoordinator,
  WriteOp
} from "../ports/write-coordinator.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import type { EntityId, WriteError } from "../domain/index.ts";
import { taskIdFromEntityId } from "../domain/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import { assertDocumentWritePathsDoNotCollide } from "./markdown-artifact-store.ts";
import {
  createHarnessRuntimeContext,
  type HarnessLayoutInput,
  resolveHarnessLayout,
} from "../layout/index.ts";
import { updateTaskProjectionIncrementally } from "../projection/sqlite-task-incremental-projection.ts";
import { hashTaskProjectionRows } from "../projection/sqlite-task-projection.ts";
import { captureAuthoredProjectionFingerprint } from "../projection/projection-source-baseline.ts";
import { appendJsonLineDurably, readDurableState, readPayloadRef, writeWatermarkDurably, writeFileDurably } from "./write-journal-durable.ts";
import { assertCommitPlanAddable, commitTouchedPaths } from "./write-journal-git.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
import { assertCodeDocGitEvidence, assertNoUncoordinatedCodeDocChange } from "./write-journal-code-doc-policy.ts";
import { writeJournalRecordCommitSummary } from "./write-journal-commit-summary.ts";
import { runLedgerMaterializer } from "./ledger-materializer.ts";
import { createAttributionEvent, makeLocalGitAttributionEventStore, planAttributionEventCommit, type AttributionEventStore } from "./write-journal-attribution-events.ts";
import { assertDirectWriteAllowed, withRepoLocks, WriteLockHeldError } from "./write-journal-locks.ts";
import { NonTaskWriteEntityError, taskIdForJournalRecord } from "./write-journal-entity.ts";
import { rejectWrite, WriteRejectedError } from "./write-journal-rejection.ts";
import {
  assertRecordMatchesAttributedOp,
  assertRecordMatchesOperationalOp,
  createAttributedJournalRecord,
  createOperationalJournalRecord,
  decodeWriteAttribution,
  uniquePendingRecords
} from "./write-journal-records.ts";
import {
  applyWriteOp,
  claimCheckedDeclaredEntityWriteOp,
  documentWritesForWriteOp,
  materializeDeclaredEntityBlob,
  readHardDeletePayload,
  validateWriteTransaction,
  writeOpTouchedPaths
} from "./write-journal-operations.ts";
import { reconcileDurableFlush, shouldWaitForForeignCommitter } from "./write-journal-receipt.ts";
import { semanticCommitMessage } from "./write-journal-authority-trailer.ts";
import { memoizePublicationVcs } from "./write-journal-publication-vcs.ts";
import type { ApplyMarkerRecord, DeleteAuditRecord, GitCommitAuthor, JournaledWriteCoordinatorOptions, JournalRecoveryOptions, LockConflictRetryOptions, LockTakeoverRecord, OperationalActor, OperationalJournaledWriteCoordinatorOptions, ReadableJournalRecord, WriteWatermark } from "./write-journal-types.ts";
export type {
  GitCommitAuthor,
  JournalActor,
  JournalRecordV1,
  JournalRecordV2,
  JournaledWriteCoordinatorOptions,
  LegacyJournalAttribution,
  LockConflictRetryOptions,
  OperationalActor,
  ReadableJournalRecord
} from "./write-journal-types.ts";

const defaultOperationalActor: OperationalActor = { scope: "operational", kind: "agent", id: "write-coordinator" };
// Flush writes the full op-id set before compaction for recovery safety, then
// trims to a bounded recent-id window only after journal compaction succeeds.
const maxWatermarkCommittedOpIds = 128;
const defaultRetryInitialDelayMs = 25;
const defaultRetryMaxDelayMs = 250;

type JournalMappedError = WriteLockHeldError | WriteRejectedError | NonTaskWriteEntityError;

export function makeJournaledWriteCoordinator(options: JournaledWriteCoordinatorOptions): WriteCoordinator {
  return makeJournaledWriteCoordinatorInternal(options, "attributed");
}

export function makeOperationalJournaledWriteCoordinator(options: OperationalJournaledWriteCoordinatorOptions): WriteCoordinator {
  return makeJournaledWriteCoordinatorInternal(options, "operational-machine-artifact");
}

export function recoverJournaledWrites(options: JournalRecoveryOptions): Effect.Effect<RecoveryReport, WriteError> {
  return makeJournaledWriteCoordinatorInternal(options, "recovery-only").recover;
}

function makeJournaledWriteCoordinatorInternal(
  options: JournaledWriteCoordinatorOptions | OperationalJournaledWriteCoordinatorOptions | JournalRecoveryOptions,
  mode: "attributed" | "operational-machine-artifact" | "recovery-only"
): WriteCoordinator {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const journalPath = options.journalPath ?? layout.journalPath;
  const watermarkPath = options.watermarkPath ?? layout.watermarkPath;
  const operationalActor = options.operationalActor ?? defaultOperationalActor;
  const lockTtlMs = options.lockTtlMs ?? 60_000;
  const lockConflictRetry = options.lockConflictRetry;
  const heldGlobalLock = options.heldGlobalLock;
  const commitAuthor = options.commitAuthor;
  const versionControlSystem = options.versionControlSystem;
  const attributionEventStore = options.attributionEventStore ?? makeLocalGitAttributionEventStore();
  const sessionId = cleanSessionId(options.sessionId);
  const autoMaterialize = options.autoMaterialize ?? true;
  const pending: WriteOp[] = [];
  const flushOnce = (reason: FlushReason): Effect.Effect<FlushReport, WriteError> => Effect.try({
    try: () => withRepoLocks(rootDir, runtimeContext, journalPath, operationalActor, lockTtlMs, pending.map((op) => op.entityId), () => {
      const state = readDurableState(journalPath, watermarkPath, rootDir);
      pending.splice(0, pending.length);
      const pendingRecords = uniquePendingRecords(state.records, state.applied);
      return flushRecords(reason, rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem, attributionEventStore);
    }, { heldGlobalLock }),
    catch: (cause): WriteError => toJournalError(cause)
  });
  const recoverOnce: Effect.Effect<RecoveryReport, WriteError> = Effect.try({
    try: (): RecoveryReport => withRepoLocks(rootDir, runtimeContext, journalPath, operationalActor, lockTtlMs, [], () => {
      const state = readDurableState(journalPath, watermarkPath, rootDir);
      const pendingRecords = uniquePendingRecords(state.records, state.applied);
      const report = flushRecords("recovery", rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem, attributionEventStore);
      return {
        replayedOps: report.opCount,
        recoveredWatermark: report.watermark
      };
    }, { heldGlobalLock }),
    catch: (cause): WriteError => toJournalError(cause)
  });

  return {
    enqueue: (op) => Effect.try({
      try: (): WriteAck => {
        validateOp(runtimeContext, op);
        const journalOp = claimCheckedDeclaredEntityWriteOp(op);
        const attribution = mode === "attributed"
          ? decodeWriteAttribution("attribution" in options ? options.attribution : undefined, journalOp.entityId)
          : undefined;
        if (mode === "recovery-only") {
          rejectWrite("write coordinator requires request attribution", journalOp.entityId);
        }
        if (mode === "operational-machine-artifact" && !journalOp.kind.startsWith("machine_artifact_")) {
          rejectWrite("operational coordinator only accepts machine artifact writes", journalOp.entityId);
        }
        preflightWriteOp(rootDir, runtimeContext, journalOp, versionControlSystem);
        if (!heldGlobalLock) assertDirectWriteAllowed(rootDir, runtimeContext, lockTtlMs);
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        const existing = state.records.find((record) => record.opId === journalOp.opId);
        if (existing) {
          if (attribution) assertRecordMatchesAttributedOp(existing, journalOp, attribution);
          else assertRecordMatchesOperationalOp(existing, journalOp, operationalActor);
          return { opId: journalOp.opId, entityId: journalOp.entityId, accepted: true };
        }
        if (state.applied.has(journalOp.opId)) return { opId: journalOp.opId, entityId: journalOp.entityId, accepted: true };
        materializeDeclaredEntityBlob(runtimeContext, op);
        const record = attribution
          ? createAttributedJournalRecord(rootDir, journalPath, journalOp, attribution)
          : createOperationalJournalRecord(rootDir, journalPath, journalOp, operationalActor);
        appendJsonLineDurably(journalPath, record);
        pending.push(journalOp);
        return { opId: journalOp.opId, entityId: journalOp.entityId, accepted: true };
      },
      catch: (cause): WriteError => toJournalError(cause, { entityId: op.entityId })
    }),
    flush: (reason) => {
      const ownedOpIds = pending.map((op) => op.opId);
      const reconcileDurable = () => reconcileDurableFlush(reason, ownedOpIds, pending, journalPath, watermarkPath, rootDir);
      const effect = lockConflictRetry
        ? retryLockConflict(
          () => flushOnce(reason),
          lockConflictRetry,
          Date.now(),
          0,
          reconcileDurable,
          (error) => shouldWaitForForeignCommitter(error, path.join(layout.locksRoot, "global.lock"))
        )
        : flushOnce(reason).pipe(Effect.catchAll((error) => {
          const reconciled = isLockConflict(error) ? reconcileDurable() : undefined;
          return reconciled ? Effect.succeed(reconciled) : Effect.fail(error);
        }));
      return maybeAutoMaterialize(effect, runtimeContext, sessionId, autoMaterialize, versionControlSystem);
    },
    recover: lockConflictRetry
      ? retryLockConflict(() => recoverOnce, lockConflictRetry, Date.now(), 0)
      : recoverOnce
  };
}

function retryLockConflict<Result>(
  runOnce: () => Effect.Effect<Result, WriteError>,
  retry: LockConflictRetryOptions,
  startedAt: number,
  attempt: number,
  reconcileDurable?: () => Result | undefined,
  shouldContinueAfterTimeout?: (error: WriteError) => boolean
): Effect.Effect<Result, WriteError> {
  return runOnce().pipe(
    Effect.catchAll((error) => {
      if (!isLockConflict(error)) return Effect.fail(error);
      const reconciled = reconcileDurable?.();
      if (reconciled !== undefined) return Effect.succeed(reconciled);
      const remainingMs = retry.maxWaitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        if (!shouldContinueAfterTimeout?.(error)) return Effect.fail(lockConflictTimeout(error, retry.maxWaitMs));
        const delayMs = retry.maxDelayMs ?? defaultRetryMaxDelayMs;
        return Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, delayMs))).pipe(
          Effect.flatMap(() => retryLockConflict(
            runOnce,
            retry,
            Date.now(),
            0,
            reconcileDurable,
            shouldContinueAfterTimeout
          ))
        );
      }
      const delayMs = Math.min(
        remainingMs,
        retry.maxDelayMs ?? defaultRetryMaxDelayMs,
        (retry.initialDelayMs ?? defaultRetryInitialDelayMs) * (2 ** attempt)
      );
      return Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, delayMs))).pipe(
        Effect.flatMap(() => retryLockConflict(
          runOnce,
          retry,
          startedAt,
          attempt + 1,
          reconcileDurable,
          shouldContinueAfterTimeout
        ))
      );
    })
  );
}

function lockConflictTimeout(error: WriteError, maxWaitMs: number): WriteError {
  const suggestion = `timed out after ${maxWaitMs}ms; the holder may be committing, so retry the command or use the daemon-backed client when a daemon owns the lock`;
  if (error._tag === "WriteConflict") {
    return { ...error, owner: `${error.owner ?? "task write lock"}; ${suggestion}` };
  }
  if (error._tag === "GlobalWriteConflict") {
    return { ...error, owner: `${error.owner ?? "global write lock"}; ${suggestion}` };
  }
  return error;
}

function isLockConflict(error: WriteError): boolean {
  return error._tag === "GlobalWriteConflict" || error._tag === "WriteConflict";
}

function cleanSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function maybeAutoMaterialize(
  effect: Effect.Effect<FlushReport, WriteError>,
  rootInput: HarnessLayoutInput,
  sessionId: string | undefined,
  autoMaterialize: boolean,
  versionControlSystem?: VersionControlSystem
): Effect.Effect<FlushReport, WriteError> {
  if (!sessionId || !autoMaterialize) return effect;
  return effect.pipe(
    Effect.tap((report) => {
      if (report.opCount === 0 || !report.committed) return Effect.void;
      return Effect.sync(() => {
        try {
          runLedgerMaterializer(rootInput, { versionControlSystem });
        } catch {
          // The op is already committed and covered by the durable watermark.
          // Materialization is a separately retryable convergence step; letting
          // its failure flip this receipt to false would invite a duplicate retry.
        }
      });
    })
  );
}

function flushRecords(
  reason: FlushReason,
  rootDir: string,
  rootInput: HarnessLayoutInput,
  journalPath: string,
  watermarkPath: string,
  previousWatermark: WriteWatermark | null,
  records: ReadonlyArray<ReadableJournalRecord>,
  fileApplied: ReadonlySet<string>,
  sessionId?: string,
  commitAuthor?: GitCommitAuthor,
  versionControlSystem?: VersionControlSystem,
  attributionEventStore: AttributionEventStore = makeLocalGitAttributionEventStore()
): FlushReport {
  const touchedPaths: string[] = [];
  const committedOpIds: string[] = [];
  // Git topology and commit-tree queries are immutable for the lifetime of this
  // single locked publication. Reuse them across independently attributed ops
  // instead of spawning the same rev-parse/cat-file processes for every event.
  const publicationVcs = memoizePublicationVcs(versionControlSystem ?? makeLocalVersionControlSystem());
  const plannedRecords = records.map((record) => ({
    record,
    touchedPaths: recordTouchedPaths(rootDir, rootInput, record)
  }));

  assertCommitPlanAddable(rootDir, plannedRecords.flatMap((record) => record.touchedPaths), rootInput, { versionControlSystem: publicationVcs });
  const previousProjectionSourceFingerprint = records.length > 0
    ? captureAuthoredProjectionFingerprint(rootInput)
    : undefined;

  for (const { record, touchedPaths: recordTouchedPaths } of plannedRecords) {
    // Ops with a durable apply marker already mutated their file before a crash;
    // skip the (non-idempotent) file write but still commit and watermark them.
    if (!fileApplied.has(record.opId)) {
      applyRecord(rootDir, rootInput, journalPath, record);
    }
    touchedPaths.push(...recordTouchedPaths);
    committedOpIds.push(record.opId);
  }

  const eventVcs = publicationVcs;
  const attributedRecords = plannedRecords
    .map((entry) => entry.record)
    .filter((record): record is Extract<ReadableJournalRecord, { readonly schema: "write-journal/v2" }> => record.schema === "write-journal/v2");
  const eventCommitPlan = planAttributionEventCommit(rootDir, rootInput, touchedPaths, eventVcs);
  const mutationWillCommit = eventCommitPlan.willCommit;
  const eventWrites = mutationWillCommit
    ? attributedRecords
    .map((record) => attributionEventStore.ensure(record, {
      rootDir,
      rootInput,
      commitSha: eventCommitPlan.preCommitSha,
      versionControlSystem: eventVcs
    }))
    : [];
  const eventPaths = eventWrites.flatMap((write) => write.touchedPaths);
  const mutationCommitSha = commitTouchedPaths(
    rootDir,
    [...touchedPaths, ...eventPaths],
    committedOpIds,
    rootInput,
    semanticCommitMessage(
      plannedRecords.map((entry) => entry.record),
      plannedRecords.map((entry) => writeJournalRecordCommitSummary(entry.record, readVerifiedPayload(rootDir, entry.record)))
    ),
    sessionId,
    {
      author: commitAuthor,
      versionControlSystem: publicationVcs
    }
  );
  const attributionEvents = mutationWillCommit
    ? eventWrites.map((write) => write.event)
    : attributedRecords.map(createAttributionEvent);
  const confirmedAttributionOpIds = new Set(attributionEvents
    .filter((event) => attributionEventStore.confirms(event, {
      rootDir,
      rootInput,
      commitSha: mutationCommitSha,
      versionControlSystem: eventVcs
    }))
    .map((event) => event.opId));
  if (mutationWillCommit && confirmedAttributionOpIds.size !== eventWrites.length) {
    throw new Error("attribution event durability confirmation failed");
  }
  const projectionHash = committedOpIds.length > 0
    ? rebuildProjectionHash(rootDir, rootInput, touchedPaths, previousProjectionSourceFingerprint)
    : previousWatermark?.projectionHash ?? "no-projection-change";
  const allCommitted = [...(previousWatermark?.lastCommittedOpIds ?? []), ...committedOpIds];
  const recentCommitted = recentOpIds(allCommitted);
  const watermark = committedOpIds.at(-1);

  if (committedOpIds.length > 0) {
    const fullWatermark = {
      schema: "write-watermark/v1",
      lastCommittedOpIds: allCommitted,
      lastCommitSha: mutationCommitSha,
      projectionHash,
      updatedAt: new Date().toISOString()
    } satisfies WriteWatermark;
    writeWatermarkDurably(watermarkPath, fullWatermark);
    if (tryCompactJournal(journalPath, new Set(allCommitted), confirmedAttributionOpIds) && recentCommitted.length < allCommitted.length) {
      writeWatermarkDurably(watermarkPath, {
        ...fullWatermark,
        lastCommittedOpIds: recentCommitted,
        updatedAt: new Date().toISOString()
      });
    }
  }

  return {
    reason,
    opCount: records.length,
    committed: true,
    watermark
  };
}

function applyRecord(rootDir: string, rootInput: HarnessLayoutInput, journalPath: string, record: ReadableJournalRecord): void {
  const op = recordToOp(rootDir, record);
  applyWriteOp(rootInput, op);
  if (op.kind === "package_delete_hard") {
    const payload = readHardDeletePayload(op);
    appendJsonLineDurably(journalPath, {
      schema: "delete-audit/v1",
      opId: `${record.opId}:applied`,
      taskId: taskIdForJournalRecord(record),
      kind: "package_delete_hard_applied",
      actor: record.actor,
      at: new Date().toISOString(),
      reason: payload.reason
    });
  }
  // Every successful file mutation is durably recognizable before commit and the
  // global watermark. If either later step fails, replay skips the already-applied
  // effect and continues the batch instead of turning this record into a poison op.
  appendJsonLineDurably(journalPath, {
    schema: "apply-marker/v1",
    opId: record.opId,
    entityId: record.entityId,
    at: new Date().toISOString()
  });
}

function preflightWriteOp(rootDir: string, rootInput: HarnessLayoutInput, op: WriteOp, versionControlSystem?: VersionControlSystem): void {
  const vcs = versionControlSystem ?? makeLocalVersionControlSystem();
  const plan = assertCommitPlanAddable(rootDir, writeOpTouchedPaths(rootInput, op), rootInput, { versionControlSystem: vcs });
  assertCodeDocGitEvidence(rootDir, resolveHarnessLayout(rootInput).authoredRoot, op, vcs);
  if (op.kind === "task_tree_stage" && plan) {
    assertNoUncoordinatedCodeDocChange(op, vcs.workingTreeFiles(plan.repoRoot, plan.relativePaths));
  }
  try {
    assertDocumentWritePathsDoNotCollide(rootInput, documentWritesForWriteOp(op));
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), op.entityId);
  }
}

function recordToOp(rootDir: string, record: ReadableJournalRecord): WriteOp {
  const payload = readVerifiedPayload(rootDir, record);
  return {
    opId: record.opId,
    entityId: record.entityId,
    kind: record.kind,
    payload,
    ...(record.authorityIntegrity ? { authorityIntegrity: record.authorityIntegrity } : {})
  };
}

function recordTouchedPaths(rootDir: string, rootInput: HarnessLayoutInput, record: ReadableJournalRecord): ReadonlyArray<string> {
  return writeOpTouchedPaths(rootInput, recordToOp(rootDir, record));
}

function readVerifiedPayload(rootDir: string, record: ReadableJournalRecord): Record<string, unknown> {
  const payload = readPayloadRef(rootDir, record);
  const expectedHash = typeof record.payload?.payloadHash === "string" ? record.payload.payloadHash : "";
  const actualHash = stablePayloadHash(payload);
  if (expectedHash !== actualHash) {
    rejectWrite(`payload hash mismatch for op ${record.opId}`, record.entityId);
  }
  return payload;
}

function rebuildProjectionHash(
  rootDir: string,
  rootInput: HarnessLayoutInput,
  touchedPaths: ReadonlyArray<string>,
  previousSourceFingerprint: string | undefined
): string {
  const layoutOverrides = typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
  return hashTaskProjectionRows(updateTaskProjectionIncrementally({
    rootDir,
    layoutOverrides,
    touchedPaths,
    previousSourceFingerprint
  }).rows);
}

function recentOpIds(opIds: ReadonlyArray<string>): ReadonlyArray<string> {
  return opIds.slice(-maxWatermarkCommittedOpIds);
}

function tryCompactJournal(journalPath: string, coveredOpIds: ReadonlySet<string>, confirmedAttributionOpIds: ReadonlySet<string>): boolean {
  try {
    compactJournalDurably(journalPath, coveredOpIds, confirmedAttributionOpIds);
    return true;
  } catch {
    // Compaction is an optimization. The watermark is authoritative for replay,
    // so a failed compaction must not turn a committed flush into a failure.
    return false;
  }
}

function compactJournalDurably(journalPath: string, coveredOpIds: ReadonlySet<string>, confirmedAttributionOpIds: ReadonlySet<string>): void {
  if (!existsSync(journalPath)) return;
  const body = readFileSync(journalPath, "utf8");
  if (body.trim().length === 0) return;

  const retained = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const parsed = JSON.parse(line) as Partial<ReadableJournalRecord | LockTakeoverRecord | DeleteAuditRecord | ApplyMarkerRecord>;
      if (parsed.schema !== "write-journal/v1" && parsed.schema !== "write-journal/v2" && parsed.schema !== "apply-marker/v1") return true;
      if (parsed.schema === "write-journal/v2" && typeof parsed.opId === "string" && !confirmedAttributionOpIds.has(parsed.opId)) return true;
      return typeof parsed.opId !== "string" || !coveredOpIds.has(parsed.opId);
    });
  writeFileDurably(journalPath, retained.length === 0 ? "" : `${retained.join("\n")}\n`);
}

function validateOp(rootInput: HarnessLayoutInput, op: WriteOp): void {
  if (op.opId.length === 0) rejectWrite("opId is required", op.entityId);
  if (op.entityId.length === 0) rejectWrite("entityId is required", op.entityId);
  validateWriteTransaction(rootInput, op);
}

function toJournalError(cause: unknown, context: { readonly entityId?: EntityId } = {}): WriteError {
  if (isJournalMappedError(cause)) return mapJournalError(cause, context);
  return {
    _tag: "JournalUnavailable",
    cause
  };
}

function isJournalMappedError(cause: unknown): cause is JournalMappedError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "WriteLockHeldError" || cause._tag === "WriteRejectedError" || cause._tag === "NonTaskWriteEntityError")
  );
}

function mapJournalError(
  cause: JournalMappedError,
  context: { readonly entityId?: EntityId }
): WriteError {
  switch (cause._tag) {
    case "WriteLockHeldError":
      return cause.taskId
        ? { _tag: "WriteConflict", taskId: cause.taskId, owner: cause.owner }
        : { _tag: "GlobalWriteConflict", owner: cause.owner };
    case "WriteRejectedError": {
      const taskId = cause.taskId ?? (context.entityId ? taskIdFromEntityId(context.entityId) ?? undefined : undefined);
      return {
        _tag: "WriteRejected",
        ...(taskId ? { taskId } : {}),
        ...(cause.entityId ?? context.entityId ? { entityId: cause.entityId ?? context.entityId } : {}),
        reason: cause.reason,
        ...(cause.code ? { code: cause.code } : {}),
        ...(cause.currentWatermark !== undefined ? { currentWatermark: cause.currentWatermark } : {}),
        ...(cause.expectedWatermark !== undefined ? { expectedWatermark: cause.expectedWatermark } : {}),
        ...(cause.retryable !== undefined ? { retryable: cause.retryable } : {})
      };
    }
    case "NonTaskWriteEntityError":
      return { _tag: "JournalUnavailable", cause };
  }
}
