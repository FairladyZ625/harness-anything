import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { DocumentWrite } from "../ports/artifact-store-writer.ts";
import type {
  FlushReason,
  FlushReport,
  RecoveryReport,
  WriteAck,
  WriteCoordinator,
  WriteOp
} from "../ports/write-coordinator.ts";
import type { EntityId, TaskId, WriteError } from "../domain/index.ts";
import {
  findEntityRefs,
  isDomainStatus,
  isPackageDisposition,
  isTerminalStatus,
  taskEntityId,
  taskIdFromEntityId
} from "../domain/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { assertDocumentWritePathsDoNotCollide, writeDocument } from "./markdown-artifact-store.ts";
import {
  createHarnessRuntimeContext,
  createTaskPackagePath,
  type HarnessLayoutInput,
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
  taskPackagePath
} from "../layout/index.ts";
import { hashTaskProjectionRows, rebuildTaskProjection } from "../projection/sqlite-task-projection.ts";
import { appendJsonLineDurably, readDurableState, readPayloadRef, writePayloadRef, writeWatermarkDurably, writeFileDurably } from "./write-journal-durable.ts";
import { commitTouchedPaths, resolveCommitPlan } from "./write-journal-git.ts";
import { withRepoLocks, WriteLockHeldError } from "./write-journal-locks.ts";
import { NonTaskWriteEntityError, taskIdForJournalRecord, taskIdForWriteOp } from "./write-journal-entity.ts";
import { decisionDocumentTargetPath, decisionWriteKinds, writeDecisionDocument } from "./write-journal-decision-documents.ts";
import { rejectTaskWrite, rejectWrite, WriteRejectedError } from "./write-journal-rejection.ts";
import type { ApplyMarkerRecord, DeleteAuditRecord, JournalActor, JournalRecord, JournalRecordKind, JournaledWriteCoordinatorOptions, LockTakeoverRecord, WriteWatermark } from "./write-journal-types.ts";
export type { JournalActor, JournaledWriteCoordinatorOptions } from "./write-journal-types.ts";

const defaultActor: JournalActor = { kind: "agent", id: "local" };
// Flush writes the full op-id set before compaction for recovery safety, then
// trims to a bounded recent-id window only after journal compaction succeeds.
const maxWatermarkCommittedOpIds = 128;

type JournalMappedError = WriteLockHeldError | WriteRejectedError | NonTaskWriteEntityError;

export function makeJournaledWriteCoordinator(options: JournaledWriteCoordinatorOptions): WriteCoordinator {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const journalPath = options.journalPath ?? layout.journalPath;
  const watermarkPath = options.watermarkPath ?? layout.watermarkPath;
  const actor = options.actor ?? defaultActor;
  const lockTtlMs = options.lockTtlMs ?? 60_000;
  const pending: WriteOp[] = [];

  return {
    enqueue: (op) => Effect.try({
      try: (): WriteAck => {
        validateOp(runtimeContext, op);
        preflightWriteOp(rootDir, runtimeContext, op);
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
    flush: (reason) => Effect.try({
      try: () => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, pending.map((op) => op.entityId), () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        pending.splice(0, pending.length);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        return flushRecords(reason, rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied);
      }),
      catch: (cause): WriteError => toJournalError(cause)
    }),
    recover: Effect.try({
      try: (): RecoveryReport => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, [], () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        const report = flushRecords("recovery", rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords, state.fileApplied);
        return {
          replayedOps: report.opCount,
          recoveredWatermark: report.watermark
        };
      }),
      catch: (cause): WriteError => toJournalError(cause)
    })
  };
}

function flushRecords(
  reason: FlushReason,
  rootDir: string,
  rootInput: HarnessLayoutInput,
  journalPath: string,
  watermarkPath: string,
  previousWatermark: WriteWatermark | null,
  records: ReadonlyArray<JournalRecord>,
  fileApplied: ReadonlySet<string>
): FlushReport {
  const touchedPaths: string[] = [];
  const committedOpIds: string[] = [];
  const plannedRecords = records.map((record) => ({
    record,
    touchedPaths: recordTouchedPaths(rootDir, rootInput, record)
  }));

  resolveCommitPlan(rootDir, plannedRecords.flatMap((record) => record.touchedPaths), rootInput);

  for (const { record, touchedPaths: recordTouchedPaths } of plannedRecords) {
    // Ops with a durable apply marker already mutated their file before a crash;
    // skip the (non-idempotent) file write but still commit and watermark them.
    if (!fileApplied.has(record.opId)) {
      applyRecord(rootDir, rootInput, journalPath, record);
    }
    touchedPaths.push(...recordTouchedPaths);
    committedOpIds.push(record.opId);
  }

  const lastCommitSha = commitTouchedPaths(rootDir, touchedPaths, committedOpIds, rootInput);
  const projectionHash = committedOpIds.length > 0 ? rebuildProjectionHash(rootDir, rootInput) : previousWatermark?.projectionHash ?? "no-projection-change";
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
  applyOp(rootInput, op);
  // Delta appends are not idempotent: replaying one after a crash between apply and
  // watermark would duplicate the text. Mark the file mutation durably so replay
  // skips the write while still committing and watermarking the op (ADR-0016 D2).
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    appendJsonLineDurably(journalPath, {
      schema: "apply-marker/v1",
      opId: record.opId,
      entityId: record.entityId,
      at: new Date().toISOString()
    });
  }
}

function applyOp(rootInput: HarnessLayoutInput, op: WriteOp): DocumentWrite | null {
  if (decisionWriteKinds.has(op.kind)) {
    writeDecisionDocument(rootInput, op);
    return null;
  }
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    writeDocumentsAtomically(rootInput, op.payload.writes, taskIdForWriteOp(op));
    return null;
  }
  // ADR-0016 D2: delta-shaped progress_append reads the current on-disk file and
  // appends. Legacy full-snapshot progress_append ops fall through to the overwrite
  // path below (backward compatibility, discriminated by payload shape).
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    return applyProgressAppendDelta(rootInput, op, op.payload);
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  const write = toDocumentWrite(op);
  writeDocument(rootInput, write);
  return write;
}

interface ProgressAppendDeltaPayload {
  readonly path: string;
  readonly append: string;
  readonly packageSlug?: string;
}

function isProgressAppendDeltaPayload(payload: unknown): payload is ProgressAppendDeltaPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { readonly path?: unknown; readonly append?: unknown };
  // An ambiguous payload carrying both `append` and `body` falls through to the
  // legacy snapshot path instead of silently ignoring `body` here.
  return typeof candidate.path === "string" && typeof candidate.append === "string" && !("body" in candidate);
}

function progressAppendDeltaWrite(op: WriteOp, payload: ProgressAppendDeltaPayload): DocumentWrite {
  const taskId = taskIdForWriteOp(op);
  return {
    taskId,
    path: payload.path,
    body: "",
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function applyProgressAppendDelta(rootInput: HarnessLayoutInput, op: WriteOp, payload: ProgressAppendDeltaPayload): DocumentWrite {
  const targetPath = documentTargetPath(rootInput, progressAppendDeltaWrite(op, payload));
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const taskId = taskIdForWriteOp(op);
  const write: DocumentWrite = {
    taskId,
    path: payload.path,
    body: `${existing}${separator}${payload.append}\n`,
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
  writeDocument(rootInput, write);
  return write;
}

const documentWriteKinds = new Set<WriteOp["kind"]>([
  "package_create",
  "transition_local",
  "progress_append",
  "doc_write",
  "package_archive",
  "package_tombstone",
  "package_reopen",
  "package_supersede"
]);

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

function preflightWriteOp(rootDir: string, rootInput: HarnessLayoutInput, op: WriteOp): void {
  resolveCommitPlan(rootDir, opTouchedPaths(rootInput, op), rootInput);
  try {
    assertDocumentWritePathsDoNotCollide(rootInput, documentWritesForOp(op));
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

interface BatchDocumentWritePayload {
  readonly writes: ReadonlyArray<DocumentWrite>;
}

function isBatchDocumentWritePayload(payload: unknown): payload is BatchDocumentWritePayload {
  if (!payload || typeof payload !== "object" || !("writes" in payload)) return false;
  return Array.isArray((payload as { readonly writes?: unknown }).writes);
}

function writeDocumentsAtomically(rootInput: HarnessLayoutInput, writes: ReadonlyArray<DocumentWrite>, taskId: TaskId): void {
  if (writes.length === 0) rejectTaskWrite("batch document write requires at least one write", taskId);
  const entries = writes.map((write) => ({
    write,
    targetPath: documentTargetPath(rootInput, write)
  }));
  const targetPaths = new Set<string>();
  for (const entry of entries) {
    if (targetPaths.has(entry.targetPath)) rejectTaskWrite(`duplicate batch write target: ${entry.write.path}`, entry.write.taskId);
    targetPaths.add(entry.targetPath);
  }

  const backups = entries.map((entry) => ({
    targetPath: entry.targetPath,
    existed: existsSync(entry.targetPath),
    body: existsSync(entry.targetPath) ? readFileSync(entry.targetPath, "utf8") : null
  }));

  try {
    for (const entry of entries) writeDocument(rootInput, entry.write);
  } catch (error) {
    for (const backup of backups.reverse()) {
      if (backup.existed && backup.body !== null) {
        mkdirSync(path.dirname(backup.targetPath), { recursive: true });
        writeFileSync(backup.targetPath, backup.body, "utf8");
      } else {
        rmSync(backup.targetPath, { force: true });
      }
    }
    throw error;
  }
}

function recordTouchedPaths(rootDir: string, rootInput: HarnessLayoutInput, record: JournalRecord): ReadonlyArray<string> {
  if (record.kind === "package_delete_hard") {
    return [taskPackagePath(rootInput, taskIdForJournalRecord(record))];
  }
  return opTouchedPaths(rootInput, recordToOp(rootDir, record));
}

function opTouchedPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  if (decisionWriteKinds.has(op.kind)) {
    return [decisionDocumentTargetPath(rootInput, op)];
  }
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    return op.payload.writes.map((write) => documentTargetPath(rootInput, write));
  }
  if (op.kind === "package_delete_hard") {
    return [taskPackagePath(rootInput, taskIdForWriteOp(op))];
  }
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    return [documentTargetPath(rootInput, progressAppendDeltaWrite(op, op.payload))];
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  return [documentTargetPath(rootInput, toDocumentWrite(op))];
}

function documentWritesForOp(op: WriteOp): ReadonlyArray<DocumentWrite> {
  if (decisionWriteKinds.has(op.kind)) {
    return [];
  }
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    return op.payload.writes;
  }
  if (op.kind === "package_delete_hard") {
    return [];
  }
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    return [progressAppendDeltaWrite(op, op.payload)];
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  return [toDocumentWrite(op)];
}

function documentTargetPath(rootInput: HarnessLayoutInput, write: DocumentWrite): string {
  const safePath = normalizeWriteDocumentPath(write.path, taskEntityId(write.taskId));
  const rootPath = existsSync(taskPackagePath(rootInput, write.taskId))
    ? taskPackagePath(rootInput, write.taskId)
    : createTaskPackagePath(rootInput, write.taskId, write.packageSlug);
  return path.join(rootPath, safePath);
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
  const disposition = readScalar(frontmatter, "packageDisposition");
  if (!isPackageDisposition(disposition)) {
    rejectTaskWrite(`hard delete forbidden: invalid package disposition ${taskId}`, taskId);
  }
  if (disposition === "archived") {
    rejectTaskWrite(`hard delete forbidden for archived task: ${taskId}`, taskId);
  }
  const status = readScalar(frontmatter, "  status");
  if (!isDomainStatus(status)) rejectTaskWrite(`hard delete forbidden: invalid task status ${taskId}`, taskId);
  if (isTerminalStatus(status)) {
    rejectTaskWrite(`hard delete forbidden for terminal task: ${taskId}`, taskId);
  }
  if (hasTaskRelations(rootInput, taskId, packagePath)) {
    rejectTaskWrite(`hard delete forbidden for related task: ${taskId}`, taskId);
  }
}

function hasTaskRelations(rootInput: HarnessLayoutInput, taskId: TaskId, ownPackage: string): boolean {
  for (const filePath of listTextFiles(resolveHarnessLayout(rootInput).authoredRoot)) {
    const body = readFileSync(filePath, "utf8");
    const refs = findEntityRefs(body);
    if (refs.some((ref) => !ref.externalHarness && ref.id === taskId)) return true;
    if (filePath.startsWith(ownPackage) && refs.some((ref) => !ref.externalHarness && ref.id !== taskId)) return true;
  }
  return false;
}

function listTextFiles(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
    const fullPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextFiles(fullPath));
      continue;
    }
    if (/\.(md|markdown|txt|ya?ml|json)$/iu.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function toDocumentWrite(op: WriteOp): DocumentWrite {
  const payload = op.payload as Partial<DocumentWrite> | undefined;
  if (!payload || typeof payload.path !== "string" || typeof payload.body !== "string") {
    rejectWrite(`${op.kind} op requires path and body payload: ${op.opId}`, op.entityId);
  }
  const taskId = taskIdForWriteOp(op);
  return {
    taskId,
    path: payload.path,
    body: payload.body,
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function rebuildProjectionHash(rootDir: string, rootInput: HarnessLayoutInput): string {
  const layoutOverrides = typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
  return hashTaskProjectionRows(rebuildTaskProjection({ rootDir, layoutOverrides }).rows);
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

function normalizeWriteDocumentPath(documentPath: string, entityId?: EntityId): string {
  try {
    return normalizeRelativeDocumentPath(documentPath);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), entityId);
  }
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
      return taskId
        ? { _tag: "WriteRejected", taskId, reason: cause.reason }
        : { _tag: "JournalUnavailable", cause };
    }
    case "NonTaskWriteEntityError":
      return { _tag: "JournalUnavailable", cause };
  }
}
