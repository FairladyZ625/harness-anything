import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
import { sha256Text, stablePayloadHash } from "./hash.ts";
import { writeDocument } from "./markdown-artifact-store.ts";
import {
  createTaskPackagePath,
  normalizeRelativeDocumentPath,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  taskPackagePath
} from "../layout/index.ts";

export interface JournaledWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly journalPath?: string;
  readonly watermarkPath?: string;
  readonly actor?: JournalActor;
  readonly lockTtlMs?: number;
}

export interface JournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

interface PayloadRef {
  readonly path: string;
  readonly sha256: string;
}

type JournalRecordKind = WriteOp["kind"];

interface JournalRecord {
  readonly schema: "write-journal/v1";
  readonly opId: string;
  readonly taskId: TaskId;
  readonly kind: JournalRecordKind;
  readonly actor: JournalActor;
  readonly at: string;
  readonly payloadRef?: PayloadRef;
  readonly payload?: Record<string, unknown>;
}

interface LockTakeoverRecord {
  readonly schema: "lock-takeover/v1";
  readonly actor: JournalActor;
  readonly at: string;
  readonly lockPath: string;
  readonly oldPid: number;
  readonly reason: string;
}

interface DeleteAuditRecord {
  readonly schema: "delete-audit/v1";
  readonly opId: string;
  readonly taskId: TaskId;
  readonly kind: "package_delete_hard_applied";
  readonly actor: JournalActor;
  readonly at: string;
  readonly reason: string;
}

interface WriteWatermark {
  readonly schema: "write-watermark/v1";
  readonly lastCommittedOpIds: ReadonlyArray<string>;
  readonly lastCommitSha: string;
  readonly projectionHash: string;
  readonly updatedAt: string;
}

interface LockRecord {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly ownerToken: string;
}

interface OwnedLock {
  readonly path: string;
  readonly ownerToken: string;
}

const defaultActor: JournalActor = { kind: "agent", id: "local" };

export function makeJournaledWriteCoordinator(options: JournaledWriteCoordinatorOptions): WriteCoordinator {
  const rootDir = path.resolve(options.rootDir);
  const layout = resolveHarnessLayout(rootDir);
  const journalPath = options.journalPath ?? layout.journalPath;
  const watermarkPath = options.watermarkPath ?? layout.watermarkPath;
  const actor = options.actor ?? defaultActor;
  const lockTtlMs = options.lockTtlMs ?? 60_000;
  const pending: WriteOp[] = [];

  return {
    enqueue: (op) => Effect.try({
      try: (): WriteAck => {
        validateOp(rootDir, op);
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        if (state.applied.has(op.opId) || state.records.some((record) => record.opId === op.opId) || pending.some((item) => item.opId === op.opId)) {
          return { opId: op.opId, taskId: op.taskId, accepted: true };
        }

        const record = createJournalRecord(rootDir, journalPath, op, actor);
        appendJsonLineDurably(journalPath, record);
        pending.push(op);
        return { opId: op.opId, taskId: op.taskId, accepted: true };
      },
      catch: (cause): WriteError => toJournalError(cause)
    }),
    flush: (reason) => Effect.try({
      try: () => withRepoLocks(rootDir, journalPath, actor, lockTtlMs, pending.map((op) => op.taskId), () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        pending.splice(0, pending.length);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        return flushRecords(reason, rootDir, journalPath, watermarkPath, state.watermark, pendingRecords);
      }),
      catch: (cause): WriteError => toJournalError(cause)
    }),
    recover: Effect.try({
      try: (): RecoveryReport => withRepoLocks(rootDir, journalPath, actor, lockTtlMs, [], () => {
        const state = readDurableState(journalPath, watermarkPath, rootDir);
        const pendingRecords = state.records.filter((record) => !state.applied.has(record.opId));
        const report = flushRecords("recovery", rootDir, journalPath, watermarkPath, state.watermark, pendingRecords);
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
  journalPath: string,
  watermarkPath: string,
  previousWatermark: WriteWatermark | null,
  records: ReadonlyArray<JournalRecord>
): FlushReport {
  const touchedPaths: string[] = [];
  const committedOpIds: string[] = [];

  for (const record of records) {
    applyRecord(rootDir, journalPath, record);
    touchedPaths.push(resolveHarnessLayout(rootDir).authoredRoot);
    committedOpIds.push(record.opId);
  }

  const lastCommitSha = commitTouchedPaths(rootDir, touchedPaths, committedOpIds);
  const projectionHash = rebuildProjectionStub(committedOpIds);
  const allCommitted = [...(previousWatermark?.lastCommittedOpIds ?? []), ...committedOpIds];
  const watermark = committedOpIds.at(-1);

  if (committedOpIds.length > 0) {
    writeWatermarkDurably(watermarkPath, {
      schema: "write-watermark/v1",
      lastCommittedOpIds: allCommitted,
      lastCommitSha,
      projectionHash,
      updatedAt: new Date().toISOString()
    });
  }

  return {
    reason,
    opCount: records.length,
    committed: true,
    watermark
  };
}

function applyRecord(rootDir: string, journalPath: string, record: JournalRecord): void {
  if (record.kind === "package_delete_hard") {
    const payload = readHardDeletePayload(rootDir, record);
    assertHardDeleteAllowed(rootDir, record.taskId, { allowMissing: true });
    rmSync(taskPackagePath(rootDir, record.taskId), { recursive: true, force: true });
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
  applyOp(rootDir, recordToOp(rootDir, record));
}

function applyOp(rootDir: string, op: WriteOp): DocumentWrite | null {
  if (op.kind === "package_supersede" && isBatchDocumentWritePayload(op.payload)) {
    writeDocumentsAtomically(rootDir, op.payload.writes);
    return null;
  }
  if (!documentWriteKinds.has(op.kind)) {
    throw new Error(`unsupported write op kind: ${op.kind}`);
  }
  const write = toDocumentWrite(op);
  writeDocument(rootDir, write);
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
    throw new Error(`write op payload must be an object: ${op.opId}`);
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

function writeDocumentsAtomically(rootDir: string, writes: ReadonlyArray<DocumentWrite>): void {
  if (writes.length === 0) throw new Error("batch document write requires at least one write");
  const entries = writes.map((write) => ({
    write,
    targetPath: documentTargetPath(rootDir, write)
  }));
  const targetPaths = new Set<string>();
  for (const entry of entries) {
    if (targetPaths.has(entry.targetPath)) throw new Error(`duplicate batch write target: ${entry.write.path}`);
    targetPaths.add(entry.targetPath);
  }

  const backups = entries.map((entry) => ({
    targetPath: entry.targetPath,
    existed: existsSync(entry.targetPath),
    body: existsSync(entry.targetPath) ? readFileSync(entry.targetPath, "utf8") : null
  }));

  try {
    for (const entry of entries) writeDocument(rootDir, entry.write);
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

function documentTargetPath(rootDir: string, write: DocumentWrite): string {
  const safePath = normalizeRelativeDocumentPath(write.path);
  const rootPath = existsSync(taskPackagePath(rootDir, write.taskId))
    ? taskPackagePath(rootDir, write.taskId)
    : createTaskPackagePath(rootDir, write.taskId, write.packageSlug);
  return path.join(rootPath, safePath);
}

function readHardDeletePayload(rootDir: string, record: JournalRecord): { readonly reason: string } {
  const payload = readVerifiedPayload(rootDir, record);
  if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
    throw new Error(`hard delete requires reason payload: ${record.opId}`);
  }
  return { reason: payload.reason };
}

function readVerifiedPayload(rootDir: string, record: JournalRecord): Record<string, unknown> {
  const payload = readPayloadRef(rootDir, record);
  const expectedHash = typeof record.payload?.payloadHash === "string" ? record.payload.payloadHash : "";
  const actualHash = stablePayloadHash(payload);
  if (expectedHash !== actualHash) {
    throw new Error(`payload hash mismatch for op ${record.opId}`);
  }
  return payload;
}

function assertHardDeleteAllowed(
  rootDir: string,
  taskId: TaskId,
  options: { readonly allowMissing?: boolean } = {}
): void {
  const packagePath = taskPackagePath(rootDir, taskId);
  const indexPath = path.join(packagePath, "INDEX.md");
  if (!existsSync(indexPath)) {
    if (options.allowMissing) return;
    throw new Error(`hard delete forbidden: task package missing ${taskId}`);
  }

  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) throw new Error(`hard delete forbidden: malformed task package ${taskId}`);
  const disposition = readScalar(frontmatter, "packageDisposition");
  if (!isPackageDisposition(disposition)) {
    throw new Error(`hard delete forbidden: invalid package disposition ${taskId}`);
  }
  if (disposition === "archived") {
    throw new Error(`hard delete forbidden for archived task: ${taskId}`);
  }
  const status = readScalar(frontmatter, "  status");
  if (!isDomainStatus(status)) throw new Error(`hard delete forbidden: invalid task status ${taskId}`);
  if (isTerminalStatus(status)) {
    throw new Error(`hard delete forbidden for terminal task: ${taskId}`);
  }
  if (hasTaskRelations(rootDir, taskId, packagePath)) {
    throw new Error(`hard delete forbidden for related task: ${taskId}`);
  }
}

function hasTaskRelations(rootDir: string, taskId: TaskId, ownPackage: string): boolean {
  for (const filePath of listTextFiles(resolveHarnessLayout(rootDir).authoredRoot)) {
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
    throw new Error(`doc_write op requires path and body payload: ${op.opId}`);
  }
  return {
    taskId: op.taskId,
    path: payload.path,
    body: payload.body,
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function readDurableState(journalPath: string, watermarkPath: string, rootDir: string): {
  readonly records: ReadonlyArray<JournalRecord>;
  readonly watermark: WriteWatermark | null;
  readonly applied: ReadonlySet<string>;
} {
  const watermark = readWatermark(watermarkPath);
  const records = readJournal(journalPath, rootDir);
  return {
    records,
    watermark,
    applied: new Set(watermark?.lastCommittedOpIds ?? [])
  };
}

function readJournal(journalPath: string, rootDir: string): ReadonlyArray<JournalRecord> {
  if (!existsSync(journalPath)) return [];
  const body = readFileSync(journalPath, "utf8").trim();
  if (body.length === 0) return [];

  const records: JournalRecord[] = [];
  for (const line of body.split("\n")) {
    const parsed = JSON.parse(line) as Partial<JournalRecord | LockTakeoverRecord | DeleteAuditRecord>;
    if (parsed.schema === "lock-takeover/v1") continue;
    if (parsed.schema === "delete-audit/v1") continue;
    if (parsed.schema !== "write-journal/v1") {
      throw new Error("malformed journal record: unsupported schema");
    }
    if (
      typeof parsed.opId !== "string" ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.kind !== "string" ||
      !parsed.actor ||
      typeof parsed.at !== "string" ||
      !parsed.payloadRef
    ) {
      throw new Error("malformed journal record: missing required fields");
    }
    readPayloadRef(rootDir, parsed as JournalRecord);
    records.push(parsed as JournalRecord);
  }
  return records;
}

function findRecord(records: ReadonlyArray<JournalRecord>, opId: string): JournalRecord {
  const record = records.find((candidate) => candidate.opId === opId);
  if (!record) throw new Error(`journal record missing for op ${opId}`);
  return record;
}

function readWatermark(watermarkPath: string): WriteWatermark | null {
  if (!existsSync(watermarkPath)) return null;
  const parsed = JSON.parse(readFileSync(watermarkPath, "utf8")) as Partial<WriteWatermark>;
  if (parsed.schema !== "write-watermark/v1" || !Array.isArray(parsed.lastCommittedOpIds)) {
    throw new Error("malformed watermark");
  }
  return parsed as WriteWatermark;
}

function writePayloadRef(rootDir: string, journalPath: string, opId: string, payload: Record<string, unknown>): PayloadRef {
  const relativeJournalDir = path.relative(rootDir, path.dirname(journalPath)).split(path.sep).join("/");
  const relativePath = `${relativeJournalDir}/payloads/${encodeURIComponent(opId)}.json`;
  const absolutePath = path.join(rootDir, relativePath);
  const body = JSON.stringify(payload);
  writeFileDurably(absolutePath, body);
  return {
    path: relativePath,
    sha256: sha256Text(body)
  };
}

function readPayloadRef(rootDir: string, record: JournalRecord): Record<string, unknown> {
  if (!record.payloadRef) throw new Error(`payloadRef missing for op ${record.opId}`);
  const absolutePath = path.join(rootDir, record.payloadRef.path);
  const body = readFileSync(absolutePath, "utf8");
  const actualSha = sha256Text(body);
  if (actualSha !== record.payloadRef.sha256) {
    throw new Error(`payloadRef sha mismatch for op ${record.opId}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function appendJsonLineDurably(filePath: string, value: JournalRecord | LockTakeoverRecord | DeleteAuditRecord): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeWatermarkDurably(filePath: string, watermark: WriteWatermark): void {
  writeFileDurably(filePath, JSON.stringify(watermark));
}

function writeFileDurably(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, body, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function withRepoLocks<T>(
  rootDir: string,
  journalPath: string,
  actor: JournalActor,
  lockTtlMs: number,
  taskIds: ReadonlyArray<TaskId>,
  fn: () => T
): T {
  const locks: OwnedLock[] = [];

  try {
    const lockRoot = path.relative(rootDir, resolveHarnessLayout(rootDir).locksRoot).split(path.sep).join("/");
    locks.push(acquireLock(rootDir, journalPath, actor, `${lockRoot}/global.lock`, lockTtlMs));
    const state = readJournal(journalPath, rootDir);
    const lockedTaskIds = new Set([...taskIds, ...state.map((record) => record.taskId)]);
    for (const taskId of [...lockedTaskIds].sort()) {
      locks.push(acquireLock(rootDir, journalPath, actor, `${lockRoot}/task-${sha256Text(taskId)}.lock`, lockTtlMs));
    }
    return fn();
  } finally {
    for (const lock of locks.reverse()) releaseLock(lock);
  }
}

function acquireLock(rootDir: string, journalPath: string, actor: JournalActor, relativeLockPath: string, lockTtlMs: number): OwnedLock {
  const lockPath = path.join(rootDir, relativeLockPath);
  const claimPath = `${lockPath}.takeover`;
  const ownerToken = randomUUID();
  let staleTakeover: LockTakeoverRecord | null = null;
  let staleQuarantinePath: string | null = null;
  let ownsTakeoverClaim = false;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    clearStaleTakeoverClaim(claimPath, lockTtlMs);
    recoverQuarantinedStaleLock(lockPath);

    if (existsSync(lockPath)) {
      const existing = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
      if (!isStaleLock(existing, lockTtlMs)) {
        throw new Error(`lock already held: ${relativeLockPath}`);
      }

      acquireTakeoverClaim(claimPath, ownerToken);
      ownsTakeoverClaim = true;
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
      if (current.ownerToken !== existing.ownerToken) {
        throw new Error(`lock already held: ${relativeLockPath} changed during stale takeover`);
      }

      staleTakeover = {
        schema: "lock-takeover/v1",
        actor,
        at: new Date().toISOString(),
        lockPath: relativeLockPath,
        oldPid: existing.pid,
        reason: "stale-lock"
      };
      staleQuarantinePath = `${lockPath}.stale.${existing.ownerToken}.${ownerToken}`;
      renameSync(lockPath, staleQuarantinePath);
    } else if (existsSync(claimPath)) {
      throw new Error(`lock already held: ${relativeLockPath} takeover in progress`);
    }

    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`lock already held: ${relativeLockPath}`);
      }
      throw error;
    }
    try {
      writeSync(fd, JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        ownerToken
      } satisfies LockRecord));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (!ownsTakeoverClaim && existsSync(claimPath)) {
      releaseLock({ path: lockPath, ownerToken });
      throw new Error(`lock already held: ${relativeLockPath} takeover in progress`);
    }

    if (staleTakeover) appendJsonLineDurably(journalPath, staleTakeover);
    if (staleQuarantinePath) rmSync(staleQuarantinePath, { force: true });
    if (ownsTakeoverClaim) rmSync(claimPath, { force: true });

    return { path: lockPath, ownerToken };
  } catch (error) {
    if (ownsTakeoverClaim) rmSync(claimPath, { force: true });
    if (staleQuarantinePath && existsSync(staleQuarantinePath) && !existsSync(lockPath)) {
      renameSync(staleQuarantinePath, lockPath);
    }
    throw error;
  }
}

function releaseLock(lock: OwnedLock): void {
  if (!existsSync(lock.path)) return;
  const current = JSON.parse(readFileSync(lock.path, "utf8")) as Partial<LockRecord>;
  if (current.ownerToken === lock.ownerToken) unlinkSync(lock.path);
}

function fsyncDirectory(dirPath: string): void {
  const fd = openSync(dirPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function acquireTakeoverClaim(claimPath: string, ownerToken: string): void {
  let fd: number;
  try {
    fd = openSync(claimPath, "wx");
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`lock already held: ${path.basename(claimPath, ".takeover")} takeover in progress`);
    }
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      ownerToken,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(path.dirname(claimPath));
}

function isStaleLock(record: LockRecord, lockTtlMs: number): boolean {
  if (record.hostname === hostname() && !pidAlive(record.pid)) return true;
  if (record.hostname === hostname() && pidAlive(record.pid)) return false;
  const age = Date.now() - Date.parse(record.heartbeatAt);
  return Number.isFinite(age) && age > lockTtlMs;
}

function clearStaleTakeoverClaim(claimPath: string, lockTtlMs: number): void {
  if (!existsSync(claimPath)) return;
  const record = readClaimRecord(claimPath);
  if (!record) {
    throw new Error(`lock already held: ${path.basename(claimPath, ".takeover")} takeover in progress`);
  }
  if (!isStaleLock(record, lockTtlMs)) {
    throw new Error(`lock already held: ${path.basename(claimPath, ".takeover")} takeover in progress`);
  }
  rmSync(claimPath, { force: true });
}

function readClaimRecord(claimPath: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(claimPath, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

function recoverQuarantinedStaleLock(lockPath: string): void {
  if (existsSync(lockPath)) return;
  const lockDir = path.dirname(lockPath);
  const quarantinePrefix = `${path.basename(lockPath)}.stale.`;
  const quarantine = readdirSync(lockDir)
    .filter((entry) => entry.startsWith(quarantinePrefix))
    .sort()[0];
  if (!quarantine) return;
  renameSync(path.join(lockDir, quarantine), lockPath);
  fsyncDirectory(lockDir);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function commitTouchedPaths(rootDir: string, touchedPaths: ReadonlyArray<string>, opIds: ReadonlyArray<string>): string {
  if (touchedPaths.length === 0 || !isGitRepo(rootDir)) return "no-git-change";

  const relativePaths = touchedPaths.map((filePath) => path.relative(rootDir, filePath));
  execFileSync("git", ["-C", rootDir, "add", "--", ...relativePaths], { stdio: "ignore" });
  const staged = execFileSync("git", ["-C", rootDir, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
  if (staged.length === 0) return currentGitHead(rootDir);

  execFileSync("git", ["-C", rootDir, "commit", "-m", `harness write ${opIds.join(",")}`], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Harness Anything",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "harness@example.invalid",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Harness Anything",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "harness@example.invalid"
    }
  });
  return currentGitHead(rootDir);
}

function isGitRepo(rootDir: string): boolean {
  try {
    execFileSync("git", ["-C", rootDir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function currentGitHead(rootDir: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "no-git-head";
  }
}

function rebuildProjectionStub(opIds: ReadonlyArray<string>): string {
  return sha256Text(`projection-rebuild:v1:${opIds.join(",")}`);
}

function validateOp(rootDir: string, op: WriteOp): void {
  if (op.opId.length === 0) throw new Error("opId is required");
  if (op.taskId.length === 0) throw new Error("taskId is required");
  if (op.kind === "package_delete_hard") {
    const payload = toJournalPayload(op);
    if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
      throw new Error(`hard delete requires reason payload: ${op.opId}`);
    }
    assertHardDeleteAllowed(rootDir, op.taskId);
  }
}

function toJournalError(cause: unknown): WriteError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("lock already held")) {
    return {
      _tag: "WriteConflict",
      taskId: "unknown",
      owner: message
    };
  }
  if (message.includes("unsupported write op kind") || message.includes("payload") || message.includes("hard delete forbidden")) {
    return {
      _tag: "WriteRejected",
      taskId: "unknown",
      reason: message
    };
  }
  return {
    _tag: "JournalUnavailable",
    cause
  };
}
