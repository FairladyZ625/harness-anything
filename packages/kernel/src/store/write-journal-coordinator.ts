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
import { readMarkdownSource } from "../projection/sqlite-task-source.ts";
import { appendJsonLineDurably, readDurableState, readPayloadRef, writePayloadRef, writeWatermarkDurably, writeFileDurably } from "./write-journal-durable.ts";
import { assertCommitPlanAddable, commitTouchedPaths } from "./write-journal-git.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
import { assertCodeDocGitEvidence, assertNoUncoordinatedCodeDocChange } from "./write-journal-code-doc-policy.ts";
import { runLedgerMaterializer } from "./ledger-materializer.ts";
import { assertDirectWriteAllowed, withRepoLocks, WriteLockHeldError } from "./write-journal-locks.ts";
import { NonTaskWriteEntityError, taskIdForJournalRecord } from "./write-journal-entity.ts";
import { rejectWrite, WriteRejectedError } from "./write-journal-rejection.ts";
import {
  applyWriteOp,
  documentWritesForWriteOp,
  readHardDeletePayload,
  validateWriteTransaction,
  writeOpTouchedPaths
} from "./write-journal-operations.ts";
import type { ApplyMarkerRecord, DeleteAuditRecord, GitCommitAuthor, JournalActor, JournalRecord, JournalRecordKind, JournaledWriteCoordinatorOptions, LockConflictRetryOptions, LockTakeoverRecord, WriteWatermark } from "./write-journal-types.ts";
export type { GitCommitAuthor, JournalActor, JournaledWriteCoordinatorOptions, LockConflictRetryOptions } from "./write-journal-types.ts";

const defaultActor: JournalActor = { kind: "agent", id: "local" };
// Flush writes the full op-id set before compaction for recovery safety, then
// trims to a bounded recent-id window only after journal compaction succeeds.
const maxWatermarkCommittedOpIds = 128;
const defaultRetryInitialDelayMs = 25;
const defaultRetryMaxDelayMs = 250;

type JournalMappedError = WriteLockHeldError | WriteRejectedError | NonTaskWriteEntityError;

export function makeJournaledWriteCoordinator(options: JournaledWriteCoordinatorOptions): WriteCoordinator {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const journalPath = options.journalPath ?? layout.journalPath;
  const watermarkPath = options.watermarkPath ?? layout.watermarkPath;
  const actor = options.actor ?? defaultActor;
  const lockTtlMs = options.lockTtlMs ?? 60_000;
  const lockConflictRetry = options.lockConflictRetry;
  const heldGlobalLock = options.heldGlobalLock;
  const commitAuthor = options.commitAuthor;
  const versionControlSystem = options.versionControlSystem;
  const sessionId = cleanSessionId(options.sessionId);
  const autoMaterialize = options.autoMaterialize ?? true;
  const pending: WriteOp[] = [];
  const flushOnce = (reason: FlushReason): Effect.Effect<FlushReport, WriteError> => Effect.try({
    try: () => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, pending.map((op) => op.entityId), () => {
      const state = readDurableState(journalPath, watermarkPath, rootDir);
      pending.splice(0, pending.length);
      const pendingRecords = uniquePendingRecords(state.records, state.applied);
      return flushRecords(reason, rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem);
    }, { heldGlobalLock }),
    catch: (cause): WriteError => toJournalError(cause)
  });
  const recoverOnce: Effect.Effect<RecoveryReport, WriteError> = Effect.try({
    try: (): RecoveryReport => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, [], () => {
      const state = readDurableState(journalPath, watermarkPath, rootDir);
      const pendingRecords = uniquePendingRecords(state.records, state.applied);
      const report = flushRecords("recovery", rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem);
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
        preflightWriteOp(rootDir, runtimeContext, op, versionControlSystem);
        if (!heldGlobalLock) assertDirectWriteAllowed(rootDir, runtimeContext, lockTtlMs);
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        if (state.applied.has(op.opId) || state.records.some((record) => record.opId === op.opId) || pending.some((item) => item.opId === op.opId)) {
          return { opId: op.opId, entityId: op.entityId, accepted: true };
        }

        const record = createJournalRecord(rootDir, journalPath, op, actor);
        appendJsonLineDurably(journalPath, record);
        pending.push(op);
        return { opId: op.opId, entityId: op.entityId, accepted: true };
      },
      catch: (cause): WriteError => toJournalError(cause, { entityId: op.entityId })
    }),
    flush: (reason) => {
      const effect = lockConflictRetry ? retryLockConflict(() => flushOnce(reason), lockConflictRetry, Date.now(), 0) : flushOnce(reason);
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
  attempt: number
): Effect.Effect<Result, WriteError> {
  return runOnce().pipe(
    Effect.catchAll((error) => {
      if (!isLockConflict(error)) return Effect.fail(error);
      const remainingMs = retry.maxWaitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return Effect.fail(lockConflictTimeout(error, retry.maxWaitMs));
      const delayMs = Math.min(
        remainingMs,
        retry.maxDelayMs ?? defaultRetryMaxDelayMs,
        (retry.initialDelayMs ?? defaultRetryInitialDelayMs) * (2 ** attempt)
      );
      return Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, delayMs))).pipe(
        Effect.flatMap(() => retryLockConflict(runOnce, retry, startedAt, attempt + 1))
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

function uniquePendingRecords(
  records: ReadonlyArray<JournalRecord>,
  applied: ReadonlySet<string>
): ReadonlyArray<JournalRecord> {
  const unique = new Map<string, JournalRecord>();
  for (const record of records) {
    if (applied.has(record.opId)) continue;
    const previous = unique.get(record.opId);
    if (!previous) {
      unique.set(record.opId, record);
      continue;
    }
    if (
      previous.entityId !== record.entityId
      || previous.kind !== record.kind
      || previous.payloadRef?.sha256 !== record.payloadRef?.sha256
      || previous.payload?.payloadHash !== record.payload?.payloadHash
    ) {
      rejectWrite(`op id collision has divergent journal records: ${record.opId}`, record.entityId);
    }
  }
  return [...unique.values()];
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
  records: ReadonlyArray<JournalRecord>,
  fileApplied: ReadonlySet<string>,
  sessionId?: string,
  commitAuthor?: GitCommitAuthor,
  versionControlSystem?: VersionControlSystem
): FlushReport {
  const touchedPaths: string[] = [];
  const committedOpIds: string[] = [];
  const plannedRecords = records.map((record) => ({
    record,
    touchedPaths: recordTouchedPaths(rootDir, rootInput, record)
  }));

  assertCommitPlanAddable(rootDir, plannedRecords.flatMap((record) => record.touchedPaths), rootInput, { versionControlSystem });
  const previousProjectionSourceHash = records.length > 0 ? readMarkdownSource(rootInput).hash : undefined;

  for (const { record, touchedPaths: recordTouchedPaths } of plannedRecords) {
    // Ops with a durable apply marker already mutated their file before a crash;
    // skip the (non-idempotent) file write but still commit and watermark them.
    if (!fileApplied.has(record.opId)) {
      applyRecord(rootDir, rootInput, journalPath, record);
    }
    touchedPaths.push(...recordTouchedPaths);
    committedOpIds.push(record.opId);
  }

  const lastCommitSha = commitTouchedPaths(
    rootDir,
    touchedPaths,
    committedOpIds,
    rootInput,
    semanticCommitMessage(rootDir, plannedRecords.map((entry) => entry.record)),
    sessionId,
    {
      author: commitAuthor,
      versionControlSystem
    }
  );
  const projectionHash = committedOpIds.length > 0
    ? rebuildProjectionHash(rootDir, rootInput, touchedPaths, previousProjectionSourceHash)
    : previousWatermark?.projectionHash ?? "no-projection-change";
  const allCommitted = [...(previousWatermark?.lastCommittedOpIds ?? []), ...committedOpIds];
  const recentCommitted = recentOpIds(allCommitted);
  const watermark = committedOpIds.at(-1);

  if (committedOpIds.length > 0) {
    const fullWatermark = {
      schema: "write-watermark/v1",
      lastCommittedOpIds: allCommitted,
      lastCommitSha,
      projectionHash,
      updatedAt: new Date().toISOString()
    } satisfies WriteWatermark;
    writeWatermarkDurably(watermarkPath, fullWatermark);
    if (tryCompactJournal(journalPath, new Set(allCommitted)) && recentCommitted.length < allCommitted.length) {
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

function applyRecord(rootDir: string, rootInput: HarnessLayoutInput, journalPath: string, record: JournalRecord): void {
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

function createJournalRecord(rootDir: string, journalPath: string, op: {
  readonly opId: string;
  readonly entityId: EntityId;
  readonly kind: JournalRecordKind;
  readonly payload?: unknown;
}, actor: JournalActor): JournalRecord {
  const payload = toJournalPayload(op);
  const payloadRef = writePayloadRef(rootDir, journalPath, op.opId, payload);
  return {
    schema: "write-journal/v1",
    opId: op.opId,
    entityId: op.entityId,
    kind: op.kind,
    actor,
    at: new Date().toISOString(),
    payloadRef,
    payload: {
      payloadHash: stablePayloadHash(payload)
    }
  };
}

function preflightWriteOp(rootDir: string, rootInput: HarnessLayoutInput, op: WriteOp, versionControlSystem?: VersionControlSystem): void {
  const vcs = versionControlSystem ?? makeLocalVersionControlSystem();
  const plan = assertCommitPlanAddable(rootDir, writeOpTouchedPaths(rootInput, op), rootInput, { versionControlSystem: vcs });
  assertCodeDocGitEvidence(rootDir, op, vcs);
  if (op.kind === "task_tree_stage" && plan) {
    assertNoUncoordinatedCodeDocChange(op, vcs.workingTreeFiles(plan.repoRoot, plan.relativePaths));
  }
  try {
    assertDocumentWritePathsDoNotCollide(rootInput, documentWritesForWriteOp(op));
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), op.entityId);
  }
}

function recordToOp(rootDir: string, record: JournalRecord): WriteOp {
  const payload = readVerifiedPayload(rootDir, record);
  return {
    opId: record.opId,
    entityId: record.entityId,
    kind: record.kind,
    payload
  };
}

function toJournalPayload(op: { readonly opId: string; readonly payload?: unknown }): Record<string, unknown> {
  if (op.payload === null || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    rejectWrite(`write op payload must be an object: ${op.opId}`);
  }
  return op.payload as Record<string, unknown>;
}

function recordTouchedPaths(rootDir: string, rootInput: HarnessLayoutInput, record: JournalRecord): ReadonlyArray<string> {
  return writeOpTouchedPaths(rootInput, recordToOp(rootDir, record));
}

function readVerifiedPayload(rootDir: string, record: JournalRecord): Record<string, unknown> {
  const payload = readPayloadRef(rootDir, record);
  const expectedHash = typeof record.payload?.payloadHash === "string" ? record.payload.payloadHash : "";
  const actualHash = stablePayloadHash(payload);
  if (expectedHash !== actualHash) {
    rejectWrite(`payload hash mismatch for op ${record.opId}`, record.entityId);
  }
  return payload;
}

function semanticCommitMessage(rootDir: string, records: ReadonlyArray<JournalRecord>): string | undefined {
  if (records.length === 0) return undefined;
  const summaries = records.map((record) => recordCommitSummary(rootDir, record));
  if (summaries.length === 1) return `${summaries[0]} [${records[0]?.opId}]`;
  return `harness write: ${summaries.slice(0, 3).join("; ")}${summaries.length > 3 ? `; +${summaries.length - 3} more` : ""} [${records.map((record) => record.opId).join(",")}]`;
}

function recordCommitSummary(rootDir: string, record: JournalRecord): string {
  const parsed = parseEntityLabel(record.entityId);
  const payload = readVerifiedPayload(rootDir, record);
  const detail = recordCommitDetail(record.kind, payload);
  return `${parsed.kind}(${writeKindVerb(record.kind)}): ${parsed.id}${detail ? ` ${detail}` : ""}`;
}

function parseEntityLabel(entityId: EntityId): { readonly kind: string; readonly id: string } {
  const separator = entityId.indexOf("/");
  if (separator < 0) return { kind: "write", id: entityId };
  return { kind: entityId.slice(0, separator), id: entityId.slice(separator + 1) };
}

function writeKindVerb(kind: JournalRecordKind): string {
  return kind
    .replace(/^decision_/u, "")
    .replace(/^package_/u, "")
    .replace(/_local$/u, "")
    .replace(/^module_/u, "")
    .replace(/_write$/u, "")
    .replace(/_/gu, "-");
}

function recordCommitDetail(kind: JournalRecordKind, payload: Record<string, unknown>): string {
  if (kind === "transition_local" && typeof payload.to === "string") return `-> ${payload.to}`;
  if (kind === "progress_append") return "progress.md";
  if ((kind === "machine_artifact_write" || kind === "machine_artifact_append_jsonl") && typeof payload.path === "string") return payload.path;
  if ((kind === "doc_write" || kind === "doc_stage" || kind === "code_doc_reconcile") && typeof payload.path === "string") return payload.path;
  if (kind === "task_tree_stage") return "task package";
  if (kind === "module_registry_write" && typeof payload.operation === "string") return payload.operation;
  if (kind === "module_scaffold_write") return "scaffold";
  if (kind === "decision_relate") {
    const decision = payload.decision as { readonly relations?: ReadonlyArray<{ readonly type?: unknown; readonly target?: unknown }> } | undefined;
    const relation = decision?.relations?.at(-1);
    if (relation && typeof relation.type === "string" && typeof relation.target === "string") {
      return `${relation.type} ${relation.target.replace(/^decision\//u, "")}`;
    }
  }
  if (kind.startsWith("decision_")) {
    const decision = payload.decision as { readonly title?: unknown } | undefined;
    if (decision && typeof decision.title === "string" && decision.title.trim().length > 0) return decision.title.trim().slice(0, 72);
  }
  return "";
}

function rebuildProjectionHash(
  rootDir: string,
  rootInput: HarnessLayoutInput,
  touchedPaths: ReadonlyArray<string>,
  previousSourceHash: string | undefined
): string {
  const layoutOverrides = typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
  return hashTaskProjectionRows(updateTaskProjectionIncrementally({
    rootDir,
    layoutOverrides,
    touchedPaths,
    previousSourceHash
  }).rows);
}

function recentOpIds(opIds: ReadonlyArray<string>): ReadonlyArray<string> {
  return opIds.slice(-maxWatermarkCommittedOpIds);
}

function tryCompactJournal(journalPath: string, coveredOpIds: ReadonlySet<string>): boolean {
  try {
    compactJournalDurably(journalPath, coveredOpIds);
    return true;
  } catch {
    // Compaction is an optimization. The watermark is authoritative for replay,
    // so a failed compaction must not turn a committed flush into a failure.
    return false;
  }
}

function compactJournalDurably(journalPath: string, coveredOpIds: ReadonlySet<string>): void {
  if (!existsSync(journalPath)) return;
  const body = readFileSync(journalPath, "utf8");
  if (body.trim().length === 0) return;

  const retained = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const parsed = JSON.parse(line) as Partial<JournalRecord | LockTakeoverRecord | DeleteAuditRecord | ApplyMarkerRecord>;
      if (parsed.schema !== "write-journal/v1" && parsed.schema !== "apply-marker/v1") return true;
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
