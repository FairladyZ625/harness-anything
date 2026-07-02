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
import type { TaskId, WriteError } from "../domain/index.ts";
import { findEntityRefs, isDomainStatus, isPackageDisposition, isTerminalStatus } from "../domain/index.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { writeDocument } from "./markdown-artifact-store.ts";
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
import type { DeleteAuditRecord, JournalActor, JournalRecord, JournalRecordKind, JournaledWriteCoordinatorOptions, LockTakeoverRecord, WriteWatermark } from "./write-journal-types.ts";
export type { JournalActor, JournaledWriteCoordinatorOptions } from "./write-journal-types.ts";

const defaultActor: JournalActor = { kind: "agent", id: "local" };
// Flush writes the full op-id set before compaction for recovery safety, then
// trims to a bounded recent-id window only after journal compaction succeeds.
const maxWatermarkCommittedOpIds = 128;

class WriteRejectedError extends Error {
  readonly _tag = "WriteRejectedError";
  readonly reason: string;
  readonly taskId?: TaskId;

  constructor(reason: string, taskId?: TaskId) {
    super(reason);
    this.name = "WriteRejectedError";
    this.reason = reason;
    this.taskId = taskId;
  }
}

type JournalMappedError = WriteLockHeldError | WriteRejectedError;

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
          return { opId: op.opId, taskId: op.taskId, accepted: true };
        }

        const record = createJournalRecord(rootDir, journalPath, op, actor);
        appendJsonLineDurably(journalPath, record);
        pending.push(op);
        return { opId: op.opId, taskId: op.taskId, accepted: true };
      },
      catch: (cause): WriteError => toJournalError(cause, { taskId: op.taskId })
    }),
    flush: (reason) => Effect.try({
      try: () => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, pending.map((op) => op.taskId), () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        pending.splice(0, pending.length);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        return flushRecords(reason, rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords);
      }),
      catch: (cause): WriteError => toJournalError(cause)
    }),
    recover: Effect.try({
      try: (): RecoveryReport => withRepoLocks(rootDir, runtimeContext, journalPath, actor, lockTtlMs, [], () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        const report = flushRecords("recovery", rootDir, runtimeContext, journalPath, watermarkPath, state.watermark, pendingRecords);
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
  records: ReadonlyArray<JournalRecord>
): FlushReport {
  const touchedPaths: string[] = [];
  const committedOpIds: string[] = [];
  const plannedRecords = records.map((record) => ({
    record,
    touchedPaths: recordTouchedPaths(rootDir, rootInput, record)
  }));

  resolveCommitPlan(rootDir, plannedRecords.flatMap((record) => record.touchedPaths), rootInput);

  for (const { record, touchedPaths: recordTouchedPaths } of plannedRecords) {
    applyRecord(rootDir, rootInput, journalPath, record);
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
    const payload = readHardDeletePayload(rootDir, record);
    assertHardDeleteAllowed(rootInput, record.taskId, { allowMissing: true });
    rmSync(taskPackagePath(rootInput, record.taskId), { recursive: true, force: true });
    appendJsonLineDurably(journalPath, {
      schema: "delete-audit/v1",
      opId: `${record.opId}:applied`,
      taskId: record.taskId,
      kind: "package_delete_hard_applied",
      actor: record.actor,
      at: new Date().toISOString(),
      reason: payload.reason
    });
    return;
  }
  applyOp(rootInput, recordToOp(rootDir, record));
}

function applyOp(rootInput: HarnessLayoutInput, op: WriteOp): DocumentWrite | null {
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    writeDocumentsAtomically(rootInput, op.payload.writes, op.taskId);
    return null;
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.taskId);
  }
  const write = toDocumentWrite(op);
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
  readonly taskId: TaskId;
  readonly kind: JournalRecordKind;
  readonly payload?: unknown;
}, actor: JournalActor): JournalRecord {
  const payload = toJournalPayload(op);
  const payloadRef = writePayloadRef(rootDir, journalPath, op.opId, payload);
  return {
    schema: "write-journal/v1",
    opId: op.opId,
    taskId: op.taskId,
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
}

function recordToOp(rootDir: string, record: JournalRecord): WriteOp {
  const payload = readVerifiedPayload(rootDir, record);
  return {
    opId: record.opId,
    taskId: record.taskId,
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
  if (writes.length === 0) rejectWrite("batch document write requires at least one write", taskId);
  const entries = writes.map((write) => ({
    write,
    targetPath: documentTargetPath(rootInput, write)
  }));
  const targetPaths = new Set<string>();
  for (const entry of entries) {
    if (targetPaths.has(entry.targetPath)) rejectWrite(`duplicate batch write target: ${entry.write.path}`, taskId);
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
    return [taskPackagePath(rootInput, record.taskId)];
  }
  return opTouchedPaths(rootInput, recordToOp(rootDir, record));
}

function opTouchedPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    return op.payload.writes.map((write) => documentTargetPath(rootInput, write));
  }
  if (op.kind === "package_delete_hard") {
    return [taskPackagePath(rootInput, op.taskId)];
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`);
  }
  return [documentTargetPath(rootInput, toDocumentWrite(op))];
}

function documentTargetPath(rootInput: HarnessLayoutInput, write: DocumentWrite): string {
  const safePath = normalizeWriteDocumentPath(write.path, write.taskId);
  const rootPath = existsSync(taskPackagePath(rootInput, write.taskId))
    ? taskPackagePath(rootInput, write.taskId)
    : createTaskPackagePath(rootInput, write.taskId, write.packageSlug);
  return path.join(rootPath, safePath);
}

function readHardDeletePayload(rootDir: string, record: JournalRecord): { readonly reason: string } {
  const payload = readVerifiedPayload(rootDir, record);
  if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
    rejectWrite(`hard delete requires reason payload: ${record.opId}`, record.taskId);
  }
  return { reason: payload.reason };
}

function readVerifiedPayload(rootDir: string, record: JournalRecord): Record<string, unknown> {
  const payload = readPayloadRef(rootDir, record);
  const expectedHash = typeof record.payload?.payloadHash === "string" ? record.payload.payloadHash : "";
  const actualHash = stablePayloadHash(payload);
  if (expectedHash !== actualHash) {
    rejectWrite(`payload hash mismatch for op ${record.opId}`, record.taskId);
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
    rejectWrite(`hard delete forbidden: task package missing ${taskId}`, taskId);
  }

  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) rejectWrite(`hard delete forbidden: malformed task package ${taskId}`, taskId);
  const disposition = readScalar(frontmatter, "packageDisposition");
  if (!isPackageDisposition(disposition)) {
    rejectWrite(`hard delete forbidden: invalid package disposition ${taskId}`, taskId);
  }
  if (disposition === "archived") {
    rejectWrite(`hard delete forbidden for archived task: ${taskId}`, taskId);
  }
  const status = readScalar(frontmatter, "  status");
  if (!isDomainStatus(status)) rejectWrite(`hard delete forbidden: invalid task status ${taskId}`, taskId);
  if (isTerminalStatus(status)) {
    rejectWrite(`hard delete forbidden for terminal task: ${taskId}`, taskId);
  }
  if (hasTaskRelations(rootInput, taskId, packagePath)) {
    rejectWrite(`hard delete forbidden for related task: ${taskId}`, taskId);
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
    rejectWrite(`doc_write op requires path and body payload: ${op.opId}`, op.taskId);
  }
  return {
    taskId: op.taskId,
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
      const parsed = JSON.parse(line) as Partial<JournalRecord | LockTakeoverRecord | DeleteAuditRecord>;
      if (parsed.schema !== "write-journal/v1") return true;
      return typeof parsed.opId !== "string" || !coveredOpIds.has(parsed.opId);
    });
  writeFileDurably(journalPath, retained.length === 0 ? "" : `${retained.join("\n")}\n`);
}

function validateOp(rootInput: HarnessLayoutInput, op: WriteOp): void {
  if (op.opId.length === 0) rejectWrite("opId is required", op.taskId);
  if (op.taskId.length === 0) rejectWrite("taskId is required", op.taskId);
  if (op.kind === "package_delete_hard") {
    const payload = toJournalPayload(op);
    if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
      rejectWrite(`hard delete requires reason payload: ${op.opId}`, op.taskId);
    }
    assertHardDeleteAllowed(rootInput, op.taskId);
  }
}

function toJournalError(cause: unknown, context: { readonly taskId?: TaskId } = {}): WriteError {
  if (isJournalMappedError(cause)) return mapJournalError(cause, context);
  return {
    _tag: "JournalUnavailable",
    cause
  };
}

function normalizeWriteDocumentPath(documentPath: string, taskId?: TaskId): string {
  try {
    return normalizeRelativeDocumentPath(documentPath);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), taskId);
  }
}

function rejectWrite(reason: string, taskId?: TaskId): never {
  throw new WriteRejectedError(reason, taskId);
}

function isJournalMappedError(cause: unknown): cause is JournalMappedError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "WriteLockHeldError" || cause._tag === "WriteRejectedError")
  );
}

function mapJournalError(
  cause: JournalMappedError,
  context: { readonly taskId?: TaskId }
): WriteError {
  switch (cause._tag) {
    case "WriteLockHeldError":
      return cause.taskId
        ? { _tag: "WriteConflict", taskId: cause.taskId, owner: cause.owner }
        : { _tag: "GlobalWriteConflict", owner: cause.owner };
    case "WriteRejectedError": {
      const taskId = cause.taskId ?? context.taskId;
      return taskId
        ? { _tag: "WriteRejected", taskId, reason: cause.reason }
        : { _tag: "JournalUnavailable", cause };
    }
  }
}
