import { existsSync, readFileSync, rmSync } from "node:fs";
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
import type { EntityId, TaskId, WriteError } from "../domain/index.ts";
import {
  isDomainStatus,
  isPackageDisposition,
  isTerminalStatus,
  taskIdFromEntityId
} from "../domain/index.ts";
import { evaluateEntityDisposition } from "../entity/disposition.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { assertDocumentWritePathsDoNotCollide } from "./markdown-artifact-store.ts";
import {
  createHarnessRuntimeContext,
  type HarnessLayoutInput,
  resolveHarnessLayout,
  taskPackagePath
} from "../layout/index.ts";
import { updateTaskProjectionIncrementally } from "../projection/sqlite-task-incremental-projection.ts";
import { hashTaskProjectionRows } from "../projection/sqlite-task-projection.ts";
import { readMarkdownSource } from "../projection/sqlite-task-source.ts";
import { appendJsonLineDurably, readDurableState, readPayloadRef, writePayloadRef, writeWatermarkDurably, writeFileDurably } from "./write-journal-durable.ts";
import { commitTouchedPaths, resolveCommitPlan } from "./write-journal-git.ts";
import { runLedgerMaterializer } from "./ledger-materializer.ts";
import { assertDirectWriteAllowed, withRepoLocks, WriteLockHeldError } from "./write-journal-locks.ts";
import { NonTaskWriteEntityError, taskIdForJournalRecord, taskIdForWriteOp } from "./write-journal-entity.ts";
import { decisionDocumentTargetPath, decisionWriteKinds } from "./write-journal-decision-documents.ts";
import { rejectTaskWrite, rejectWrite, WriteRejectedError } from "./write-journal-rejection.ts";
import {
  applyWriteOp,
  documentWritesForWriteOp,
  isProgressAppendDeltaPayload,
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
      const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
      return flushRecords(reason, rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem);
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
      const effect = lockConflictRetry ? retryLockConflictFlush(() => flushOnce(reason), lockConflictRetry, Date.now(), 0) : flushOnce(reason);
    return maybeAutoMaterialize(effect, runtimeContext, sessionId, autoMaterialize, versionControlSystem);
    },
    recover: Effect.try({
      try: (): RecoveryReport => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, [], () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        const report = flushRecords("recovery", rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied, sessionId, commitAuthor, versionControlSystem);
        return {
          replayedOps: report.opCount,
          recoveredWatermark: report.watermark
        };
      }, { heldGlobalLock }),
      catch: (cause): WriteError => toJournalError(cause)
    })
  };
}

function retryLockConflictFlush(
  flushOnce: () => Effect.Effect<FlushReport, WriteError>,
  retry: LockConflictRetryOptions,
  startedAt: number,
  attempt: number
): Effect.Effect<FlushReport, WriteError> {
  return flushOnce().pipe(
    Effect.catchAll((error) => {
      if (!isLockConflict(error)) return Effect.fail(error);
      const remainingMs = retry.maxWaitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) return Effect.fail(error);
      const delayMs = Math.min(
        remainingMs,
        retry.maxDelayMs ?? defaultRetryMaxDelayMs,
        (retry.initialDelayMs ?? defaultRetryInitialDelayMs) * (2 ** attempt)
      );
      return Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, delayMs))).pipe(
        Effect.flatMap(() => retryLockConflictFlush(flushOnce, retry, startedAt, attempt + 1))
      );
    })
  );
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
      return Effect.try({
        try: () => {
          runLedgerMaterializer(rootInput, { versionControlSystem });
        },
        catch: (cause): WriteError => ({ _tag: "JournalUnavailable", cause })
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

  resolveCommitPlan(rootDir, plannedRecords.flatMap((record) => record.touchedPaths), rootInput, versionControlSystem);
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
      respectGitignorePaths: plannedRecords.filter((entry) => entry.record.kind === "task_tree_stage").flatMap((entry) => entry.touchedPaths),
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
  if (record.kind === "package_delete_hard") {
    const taskId = taskIdForJournalRecord(record);
    const payload = readHardDeletePayload(rootDir, record);
    assertHardDeleteAllowed(rootInput, taskId, { allowMissing: true });
    rmSync(taskPackagePath(rootInput, taskId), { recursive: true, force: true });
    appendJsonLineDurably(journalPath, {
      schema: "delete-audit/v1",
      opId: `${record.opId}:applied`,
      taskId,
      kind: "package_delete_hard_applied",
      actor: record.actor,
      at: new Date().toISOString(),
      reason: payload.reason
    });
    return;
  }
  const op = recordToOp(rootDir, record);
  applyWriteOp(rootInput, op);
  // Delta appends are not idempotent: replaying one after a crash between apply and
  // watermark would duplicate the text/JSONL row. Mark the file mutation durably so
  // replay skips the write while still committing and watermarking the op (ADR-0016 D2/D1).
  if ((op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) || op.kind === "machine_artifact_append_jsonl") {
    appendJsonLineDurably(journalPath, {
      schema: "apply-marker/v1",
      opId: record.opId,
      entityId: record.entityId,
      at: new Date().toISOString()
    });
  }
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
  resolveCommitPlan(rootDir, writeOpTouchedPaths(rootInput, op), rootInput, versionControlSystem);
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
  if (record.kind === "package_delete_hard") {
    return [taskPackagePath(rootInput, taskIdForJournalRecord(record))];
  }
  return writeOpTouchedPaths(rootInput, recordToOp(rootDir, record));
}

function readHardDeletePayload(rootDir: string, record: JournalRecord): { readonly reason: string } {
  const payload = readVerifiedPayload(rootDir, record);
  if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
    rejectWrite(`hard delete requires reason payload: ${record.opId}`, record.entityId);
  }
  return { reason: payload.reason };
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
  if ((kind === "doc_write" || kind === "doc_stage") && typeof payload.path === "string") return payload.path;
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

function assertHardDeleteAllowed(
  rootInput: HarnessLayoutInput,
  taskId: TaskId,
  options: { readonly allowMissing?: boolean } = {}
): void {
  const packagePath = taskPackagePath(rootInput, taskId);
  const indexPath = path.join(packagePath, "INDEX.md");
  if (!existsSync(indexPath)) {
    if (options.allowMissing) return;
    rejectTaskWrite(`hard delete forbidden: task package missing ${taskId}`, taskId);
  }

  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) rejectTaskWrite(`hard delete forbidden: malformed task package ${taskId}`, taskId);
  const packageDisposition = readScalar(frontmatter, "packageDisposition");
  if (!isPackageDisposition(packageDisposition)) {
    rejectTaskWrite(`hard delete forbidden: invalid package disposition ${taskId}`, taskId);
  }
  if (packageDisposition === "archived") {
    rejectTaskWrite(`hard delete forbidden for archived task: ${taskId}`, taskId);
  }
  const status = readScalar(frontmatter, "  status");
  if (!isDomainStatus(status)) rejectTaskWrite(`hard delete forbidden: invalid task status ${taskId}`, taskId);
  if (isTerminalStatus(status)) {
    rejectTaskWrite(`hard delete forbidden for terminal task: ${taskId}`, taskId);
  }
  const evaluation = evaluateEntityDisposition({
    rootDir: typeof rootInput === "string" ? path.resolve(rootInput) : rootInput.rootDir,
    layoutOverrides: typeof rootInput === "string" ? undefined : rootInput.layoutOverrides,
    entityRef: `task/${taskId}`,
    action: "hard-delete"
  });
  if (!evaluation.allowed) {
    rejectTaskWrite(evaluation.reason, taskId);
  }
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
  if (decisionWriteKinds.has(op.kind)) {
    decisionDocumentTargetPath(rootInput, op);
    return;
  }
  if (op.kind === "package_delete_hard") {
    const payload = toJournalPayload(op);
    if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
      rejectWrite(`hard delete requires reason payload: ${op.opId}`, op.entityId);
    }
    assertHardDeleteAllowed(rootInput, taskIdForWriteOp(op));
  }
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
