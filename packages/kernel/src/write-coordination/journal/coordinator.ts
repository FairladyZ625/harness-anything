import path from "node:path";
import { Effect } from "effect";
import type {
  FlushReason,
  FlushReport,
  RecoveryReport,
  WriteAck,
  JournalRecordWitnessV1,
  WriteCoordinator,
  WriteOp
} from "../../ports/write-coordinator.ts";
import type { VcsCommitAuthor, VcsCommitPhase, VersionControlSystem } from "../../ports/version-control-system.ts";
import type { EntityId, WriteError } from "../../domain/index.ts";
import { taskIdFromEntityId } from "../../domain/index.ts";
import { stablePayloadHash } from "../../integrity/stable-hash.ts";
import {
  createHarnessRuntimeContext,
  type HarnessLayoutInput,
  resolveHarnessLayout,
} from "../../layout/index.ts";
import type { ProjectionChangeEvent } from "../../projection/projection-change-event.ts";
import { captureTrustedAuthoredProjectionFingerprint } from "../../projection/projection-source-baseline.ts";
import { appendJsonLineDurably, readDurableState, readPayloadRef } from "./durable.ts";
import { finalizeRecoverableDocumentTransaction } from "./operations/recoverable-document-transaction.ts";
import { assertCommitPlanAddable, commitTouchedPaths } from "./publication/git.ts";
import { makeLocalVersionControlSystem } from "../../persistence/git/local-version-control-system.ts";
import { writeJournalRecordCommitSummary } from "./publication/commit-summary.ts";
import { createAttributionEvent, makeInlineAttributionEventStore, planAttributionEventCommit, type AttributionEventStore } from "../attribution/inline-attribution-event-store.ts";
import { assertDirectWriteAllowed, withRepoLocks, WriteLockHeldError } from "./locks.ts";
import { NonTaskWriteEntityError, taskIdForJournalRecord } from "./operations/entity.ts";
import { rejectWrite, WriteRejectedError } from "./rejection.ts";
import {
  assertRecordMatchesAttributedOp,
  assertRecordMatchesOperationalOp,
  createAttributedJournalRecord,
  createOperationalJournalRecord,
  decodeWriteAttribution,
  uniquePendingRecords
} from "./records.ts";
import {
  applyWriteOp,
  readHardDeletePayload,
  verifyAlreadyAppliedWriteOp,
  writeOpTouchedPaths
} from "./operations/transaction-plan.ts";
import { reconcileDurableFlush, shouldWaitForForeignCommitter } from "./receipt.ts";
import { semanticCommitMessage } from "./publication/authority-trailer.ts";
import { recoverJournalIntegrityDomains } from "./recovery/integrity-domains.ts";
import { recordsForWriteIntegrityDomain, singleWriteIntegrityDomain } from "./integrity-domain.ts";
import { memoizePublicationVcs } from "./publication/memoized-vcs.ts";
import {
  authorizeExactJournalRecord,
  createExactJournalRecordFlusher,
  createExactJournalRecordsFlusher,
  flushExactAuthorizedJournalRecords,
  flushExactAuthorizedJournalRecord
} from "./exact-journal-flush.ts";
import { maybeAutoMaterialize } from "./publication/materialization.ts";
import { finalizeJournalPostCommit } from "./post-commit.ts";
import { assertCodeDocReplacementHasAuthoredChange } from "./code-doc-reconcile-noop.ts";
import { isLocalProjectionPath } from "./projection-path.ts";
import {
  assertTranscriptConsentAnchorReservation
} from "./operations/consent-transcript-anchor.ts";
import { withTranscriptConsentReservationLock } from "./transcript-consent-reservation-lock.ts";
import { preflightWriteOp, validateWriteOp } from "./preflight.ts";
import type { JournalPostCommitPhase, JournalProjectionFingerprintPhase, JournaledWriteCoordinatorOptions, JournalRecoveryOptions, LockConflictRetryOptions, OperationalActor, OperationalJournaledWriteCoordinatorOptions, ReadableJournalRecord, WriteWatermark } from "./types.ts";
export type {
  JournalActor,
  JournalRecordV1,
  JournalRecordV2,
  JournalPostCommitPhase,
  JournalProjectionFingerprintPhase,
  JournaledWriteCoordinatorOptions,
  LegacyJournalAttribution,
  LockConflictRetryOptions,
  OperationalActor,
  ReadableJournalRecord
} from "./types.ts";

const defaultOperationalActor: OperationalActor = { scope: "operational", kind: "agent", id: "write-coordinator" };
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
  const attributionEventStore = options.attributionEventStore ?? makeInlineAttributionEventStore();
  const sessionId = cleanSessionId(options.sessionId);
  const autoMaterialize = options.autoMaterialize ?? true;
  const pending: WriteOp[] = [];
  const exactJournalAuthorizations = new Map<string, JournalRecordWitnessV1>();
  const flushOnce = (reason: FlushReason): Effect.Effect<FlushReport, WriteError> => Effect.try({
    try: () => withRepoLocks(rootDir, runtimeContext, journalPath, operationalActor, lockTtlMs, pending.map((op) => op.entityId), () => {
      const state = readDurableState(journalPath, watermarkPath, rootDir);
      const requestedDomain = singleWriteIntegrityDomain(pending);
      pending.splice(0, pending.length);
      const pendingRecords = recordsForWriteIntegrityDomain(
        uniquePendingRecords(state.records, state.applied),
        requestedDomain
      );
      return flushRecords(reason, rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem, attributionEventStore, options.onProjectionChange, options.onCommitPhase, options.onProjectionFingerprintPhase, options.onProjectionFingerprintDiagnostic, options.onPostCommitPhase);
    }, { heldGlobalLock }),
    catch: (cause): WriteError => toJournalError(cause)
  });
  const recoverOnce: Effect.Effect<RecoveryReport, WriteError> = Effect.try({
    try: (): RecoveryReport => withRepoLocks(rootDir, runtimeContext, journalPath, operationalActor, lockTtlMs, [], () => {
      return recoverJournalIntegrityDomains({
        rootDir,
        journalPath,
        watermarkPath,
        flushDomain: (state, records) => flushRecords(
          "recovery",
          rootDir,
          runtimeContext,
          journalPath,
          watermarkPath,
          state.watermark,
          records,
          state.fileApplied,
          sessionId,
          commitAuthor,
          versionControlSystem,
          attributionEventStore,
          options.onProjectionChange,
          options.onCommitPhase,
          options.onProjectionFingerprintPhase,
          options.onProjectionFingerprintDiagnostic,
          options.onPostCommitPhase
        )
      });
    }, { heldGlobalLock }),
    catch: (cause): WriteError => toJournalError(cause)
  });
  const flushExactJournalRecord = createExactJournalRecordFlusher({
    run: (reason, witness) => flushExactAuthorizedJournalRecord({
      rootDir, rootInput: runtimeContext, journalPath, watermarkPath,
      operationalActor, lockTtlMs, ...(heldGlobalLock ? { heldGlobalLock } : {}),
      witness, authorizations: exactJournalAuthorizations, pending,
      flushRecord: (state, record) => flushRecords(
        reason, rootDir, runtimeContext, journalPath, watermarkPath,
        state.watermark, [record], state.fileApplied, sessionId, commitAuthor,
        versionControlSystem, attributionEventStore, options.onProjectionChange, options.onCommitPhase, options.onProjectionFingerprintPhase, options.onProjectionFingerprintDiagnostic, options.onPostCommitPhase
      )
    }),
    mapError: (cause) => toJournalError(cause),
    finish: (effect) => maybeAutoMaterialize(
      effect, runtimeContext, sessionId, autoMaterialize, versionControlSystem
    )
  });
  const flushExactJournalRecords = createExactJournalRecordsFlusher({
    run: (reason, witnesses) => flushExactAuthorizedJournalRecords({
      rootDir, rootInput: runtimeContext, journalPath, watermarkPath,
      operationalActor, lockTtlMs, ...(heldGlobalLock ? { heldGlobalLock } : {}),
      witnesses, authorizations: exactJournalAuthorizations, pending,
      flushRecords: (state, records) => flushRecords(
        reason, rootDir, runtimeContext, journalPath, watermarkPath,
        state.watermark, records, state.fileApplied, sessionId, commitAuthor,
        versionControlSystem, attributionEventStore, options.onProjectionChange, options.onCommitPhase, options.onProjectionFingerprintPhase, options.onProjectionFingerprintDiagnostic, options.onPostCommitPhase
      )
    }),
    mapError: (cause) => toJournalError(cause),
    finish: (effect) => maybeAutoMaterialize(
      effect, runtimeContext, sessionId, autoMaterialize, versionControlSystem
    )
  });

  return {
    enqueue: (op) => Effect.try({
      try: (): WriteAck => {
        validateWriteOp(runtimeContext, op);
        // The full declared-entity payload is the recovery source of truth.  In
        // particular, a composite manifest's body must be durable in the journal
        // before apply can install its CAS object.
        const journalOp = op;
        const attribution = mode === "attributed"
          ? decodeWriteAttribution("attribution" in options ? options.attribution : undefined, journalOp.entityId)
          : undefined;
        if (mode === "recovery-only") {
          rejectWrite(
            "WriteCoordinator enqueue is unavailable in recovery-only mode because recovery replays already-attributed journal records instead of accepting new write requests. Run the original `ha` command through the CLI or daemon authority path; use `ha daemon status --json` first if recovery was expected.",
            journalOp.entityId
          );
        }
        if (mode === "operational-machine-artifact" && !journalOp.kind.startsWith("machine_artifact_")) {
          rejectWrite("operational coordinator only accepts machine artifact writes", journalOp.entityId);
        }
        const enqueueRecord = (requiresTranscriptConsentReservation: boolean): WriteAck => {
          preflightWriteOp(rootDir, runtimeContext, journalOp, versionControlSystem);
          if (!heldGlobalLock) assertDirectWriteAllowed(rootDir, runtimeContext, lockTtlMs);
          const state = readDurableState(journalPath, watermarkPath, rootDir);
          const existing = state.records.find((record) => record.opId === journalOp.opId);
          if (existing) {
            if (attribution) assertRecordMatchesAttributedOp(existing, journalOp, attribution);
            else assertRecordMatchesOperationalOp(existing, journalOp, operationalActor);
            return authorizeExactJournalRecord(
              existing,
              journalOp.entityId,
              exactJournalAuthorizations
            );
          }
          if (state.applied.has(journalOp.opId)) return { opId: journalOp.opId, entityId: journalOp.entityId, accepted: true };
          if (requiresTranscriptConsentReservation) {
            const outstandingJournaledOps = state.records
              .filter((record) => record.kind === "doc_write"
                && !state.applied.has(record.opId)
                && !state.fileApplied.has(record.opId))
              .map((record) => recordToOp(rootDir, record));
            assertTranscriptConsentAnchorReservation(runtimeContext, journalOp, outstandingJournaledOps);
          }
          const record = attribution
            ? createAttributedJournalRecord(rootDir, journalPath, journalOp, attribution)
            : createOperationalJournalRecord(rootDir, journalPath, journalOp, operationalActor);
          appendJsonLineDurably(journalPath, record);
          pending.push(journalOp);
          return authorizeExactJournalRecord(
            record,
            journalOp.entityId,
            exactJournalAuthorizations
          );
        };
        return withTranscriptConsentReservationLock({
          rootDir, rootInput: runtimeContext, journalPath, actor: operationalActor,
          lockTtlMs, op: journalOp, writeJournalRecord: enqueueRecord,
          ...(heldGlobalLock ? { heldGlobalLock } : {})
        });
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
    flushExactJournalRecords,
    flushExactJournalRecord,
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
  commitAuthor?: VcsCommitAuthor,
  versionControlSystem?: VersionControlSystem,
  attributionEventStore: AttributionEventStore = makeInlineAttributionEventStore(),
  onProjectionChange?: (event: ProjectionChangeEvent) => void,
  onCommitPhase?: (phase: VcsCommitPhase) => void,
  onProjectionFingerprintPhase?: (phase: JournalProjectionFingerprintPhase) => void,
  onProjectionFingerprintDiagnostic?: (diagnostic: import("../../projection/projection-source-baseline.ts").TrustedProjectionFingerprintDiagnostic) => void,
  onPostCommitPhase?: (phase: JournalPostCommitPhase) => void
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
  const localRoot = resolveHarnessLayout(rootInput).localRoot;
  const projectionRelevant = plannedRecords.some(({ touchedPaths: operationPaths }) =>
    operationPaths.some((filePath) => !isLocalProjectionPath(localRoot, filePath))
  );

  assertCommitPlanAddable(rootDir, plannedRecords.flatMap((record) => record.touchedPaths), rootInput, { versionControlSystem: publicationVcs });
  assertCodeDocReplacementHasAuthoredChange({
    rootDir,
    rootInput,
    plannedRecords,
    publicationVcs,
    attributionEventStore,
    readPayload: (record) => readVerifiedPayload(rootDir, record)
  });
  onProjectionFingerprintPhase?.("capture-start");
  const previousProjectionSourceFingerprint = records.length > 0 && projectionRelevant
    ? captureTrustedAuthoredProjectionFingerprint(rootInput, publicationVcs, undefined, {
      onDiagnostic: onProjectionFingerprintDiagnostic
    })
    : undefined;
  onProjectionFingerprintPhase?.("capture-done");

  for (const { record, touchedPaths: recordTouchedPaths } of plannedRecords) {
    // Ops with a durable apply marker already mutated their file before a crash;
    // skip the (non-idempotent) file write but still commit and watermark them.
    if (!fileApplied.has(record.opId)) {
      applyRecord(rootDir, rootInput, journalPath, record);
    } else {
      verifyAlreadyAppliedWriteOp(rootInput, recordToOp(rootDir, record));
      finalizeRecoverableDocumentTransaction(rootInput, record.opId);
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
      preserveExplicitLogPaths: plannedRecords.flatMap(({ touchedPaths: operationPaths }) => operationPaths),
      versionControlSystem: publicationVcs,
      ...(onCommitPhase ? { onCommitPhase } : {})
    }
  );
  const attributionEvents = mutationWillCommit
    ? eventWrites.map((write) => write.event)
    : attributedRecords.map(createAttributionEvent);
  onPostCommitPhase?.("attribution-confirm-start");
  const confirmedAttributionOpIds = new Set(attributionEvents
    .filter((event) => attributionEventStore.confirms(event, {
      rootDir,
      rootInput,
      commitSha: mutationCommitSha,
      versionControlSystem: eventVcs
    }))
    .map((event) => event.opId));
  onPostCommitPhase?.("attribution-confirm-done");
  if (mutationWillCommit && confirmedAttributionOpIds.size !== eventWrites.length) {
    throw new Error("attribution event durability confirmation failed");
  }
  finalizeJournalPostCommit({
    rootDir,
    rootInput,
    journalPath,
    watermarkPath,
    previousWatermark,
    records,
    committedOpIds,
    confirmedAttributionOpIds,
    mutationCommitSha,
    projectionRelevant,
    deferProjectionUpdate: Boolean(sessionId && mutationWillCommit),
    touchedPaths,
    previousProjectionSourceFingerprint,
    entityIds: plannedRecords.map(({ record }) => record.entityId),
    versionControlSystem: publicationVcs,
    onProjectionChange,
    onPostCommitPhase
  });

  return {
    reason,
    opCount: records.length,
    committed: true,
    watermark: committedOpIds.at(-1),
    publicationMode: "integrity-domain"
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
  finalizeRecoverableDocumentTransaction(rootInput, record.opId);
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

function toJournalError(cause: unknown, context: { readonly entityId?: EntityId } = {}): WriteError {
  if (isJournalMappedError(cause)) return mapJournalError(cause, context);
  return {
    _tag: "JournalUnavailable",
    cause: journalFailureCause(cause)
  };
}

function journalFailureCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const code = "code" in cause && (typeof cause.code === "string" || typeof cause.code === "number")
    ? cause.code
    : undefined;
  return {
    name: cause.name || "Error",
    message: cause.message,
    ...(code === undefined ? {} : { code })
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
