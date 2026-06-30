import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { stablePayloadHash } from "./hash.ts";
import { writeDocument } from "./markdown-artifact-store.ts";
import {
  createTaskPackagePath,
  normalizeRelativeDocumentPath,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  taskPackagePath
} from "../layout/index.ts";
import { hashTaskProjectionRows, rebuildTaskProjection } from "../projection/sqlite-task-projection.ts";
import { appendJsonLineDurably, readDurableState, readPayloadRef, writePayloadRef, writeWatermarkDurably, writeFileDurably } from "./write-journal-durable.ts";
import { withRepoLocks, WriteLockHeldError } from "./write-journal-locks.ts";
import type { DeleteAuditRecord, JournalActor, JournalRecord, JournalRecordKind, JournaledWriteCoordinatorOptions, LockTakeoverRecord, WriteWatermark } from "./write-journal-types.ts";
export type { JournalActor, JournaledWriteCoordinatorOptions } from "./write-journal-types.ts";

const defaultActor: JournalActor = { kind: "agent", id: "local" };
// Flush writes the full op-id set before compaction for recovery safety, then
// trims to a bounded recent-id window only after journal compaction succeeds.
const maxWatermarkCommittedOpIds = 128;
const gitMaxBuffer = 256 * 1024 * 1024;

class WriteRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "WriteRejectedError";
    this.reason = reason;
  }
}

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
        preflightWriteOp(rootDir, op);
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
  const plannedRecords = records.map((record) => ({
    record,
    touchedPaths: recordTouchedPaths(rootDir, record)
  }));

  resolveCommitPlan(rootDir, plannedRecords.flatMap((record) => record.touchedPaths));

  for (const { record, touchedPaths: recordTouchedPaths } of plannedRecords) {
    applyRecord(rootDir, journalPath, record);
    touchedPaths.push(...recordTouchedPaths);
    committedOpIds.push(record.opId);
  }

  const lastCommitSha = commitTouchedPaths(rootDir, touchedPaths, committedOpIds);
  const projectionHash = committedOpIds.length > 0 ? rebuildProjectionHash(rootDir) : previousWatermark?.projectionHash ?? "no-projection-change";
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
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    writeDocumentsAtomically(rootDir, op.payload.writes);
    return null;
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`);
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

function preflightWriteOp(rootDir: string, op: WriteOp): void {
  resolveCommitPlan(rootDir, opTouchedPaths(rootDir, op));
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

function writeDocumentsAtomically(rootDir: string, writes: ReadonlyArray<DocumentWrite>): void {
  if (writes.length === 0) rejectWrite("batch document write requires at least one write");
  const entries = writes.map((write) => ({
    write,
    targetPath: documentTargetPath(rootDir, write)
  }));
  const targetPaths = new Set<string>();
  for (const entry of entries) {
    if (targetPaths.has(entry.targetPath)) rejectWrite(`duplicate batch write target: ${entry.write.path}`);
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

function recordTouchedPaths(rootDir: string, record: JournalRecord): ReadonlyArray<string> {
  if (record.kind === "package_delete_hard") {
    return [taskPackagePath(rootDir, record.taskId)];
  }
  return opTouchedPaths(rootDir, recordToOp(rootDir, record));
}

function opTouchedPaths(rootDir: string, op: WriteOp): ReadonlyArray<string> {
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    return op.payload.writes.map((write) => documentTargetPath(rootDir, write));
  }
  if (op.kind === "package_delete_hard") {
    return [taskPackagePath(rootDir, op.taskId)];
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`);
  }
  return [documentTargetPath(rootDir, toDocumentWrite(op))];
}

function documentTargetPath(rootDir: string, write: DocumentWrite): string {
  const safePath = normalizeWriteDocumentPath(write.path);
  const rootPath = existsSync(taskPackagePath(rootDir, write.taskId))
    ? taskPackagePath(rootDir, write.taskId)
    : createTaskPackagePath(rootDir, write.taskId, write.packageSlug);
  return path.join(rootPath, safePath);
}

function readHardDeletePayload(rootDir: string, record: JournalRecord): { readonly reason: string } {
  const payload = readVerifiedPayload(rootDir, record);
  if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
    rejectWrite(`hard delete requires reason payload: ${record.opId}`);
  }
  return { reason: payload.reason };
}

function readVerifiedPayload(rootDir: string, record: JournalRecord): Record<string, unknown> {
  const payload = readPayloadRef(rootDir, record);
  const expectedHash = typeof record.payload?.payloadHash === "string" ? record.payload.payloadHash : "";
  const actualHash = stablePayloadHash(payload);
  if (expectedHash !== actualHash) {
    rejectWrite(`payload hash mismatch for op ${record.opId}`);
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
    rejectWrite(`hard delete forbidden: task package missing ${taskId}`);
  }

  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) rejectWrite(`hard delete forbidden: malformed task package ${taskId}`);
  const disposition = readScalar(frontmatter, "packageDisposition");
  if (!isPackageDisposition(disposition)) {
    rejectWrite(`hard delete forbidden: invalid package disposition ${taskId}`);
  }
  if (disposition === "archived") {
    rejectWrite(`hard delete forbidden for archived task: ${taskId}`);
  }
  const status = readScalar(frontmatter, "  status");
  if (!isDomainStatus(status)) rejectWrite(`hard delete forbidden: invalid task status ${taskId}`);
  if (isTerminalStatus(status)) {
    rejectWrite(`hard delete forbidden for terminal task: ${taskId}`);
  }
  if (hasTaskRelations(rootDir, taskId, packagePath)) {
    rejectWrite(`hard delete forbidden for related task: ${taskId}`);
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
    rejectWrite(`doc_write op requires path and body payload: ${op.opId}`);
  }
  return {
    taskId: op.taskId,
    path: payload.path,
    body: payload.body,
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function commitTouchedPaths(rootDir: string, touchedPaths: ReadonlyArray<string>, opIds: ReadonlyArray<string>): string {
  if (touchedPaths.length === 0) return "no-git-change";

  const plan = resolveCommitPlan(rootDir, touchedPaths);
  if (!plan) return "no-git-change";

  runGit(plan.repoRoot, "add", "--", ...plan.relativePaths);
  const staged = runGit(plan.repoRoot, "diff", "--cached", "--name-only", "--", ...plan.relativePaths).trim();
  if (staged.length === 0) return currentGitHead(plan.repoRoot);

  runGit(plan.repoRoot, "commit", "-m", `harness write ${opIds.join(",")}`);
  return currentGitHead(plan.repoRoot);
}

function resolveCommitPlan(rootDir: string, touchedPaths: ReadonlyArray<string>): { readonly repoRoot: string; readonly relativePaths: ReadonlyArray<string> } | null {
  if (touchedPaths.length === 0) return null;
  const target = resolveCommitTarget(rootDir, resolveHarnessLayout(rootDir).authoredRoot);
  if (!target) return null;
  return {
    repoRoot: target.repoRoot,
    relativePaths: unique(touchedPaths.map((filePath) => repoRelativePath(target.repoRoot, filePath)))
  };
}

function isGitRepo(rootDir: string): boolean {
  return gitTopLevel(rootDir) !== null;
}

function resolveCommitTarget(rootDir: string, authoredRoot: string): { readonly repoRoot: string } | null {
  const rootRepo = gitTopLevel(rootDir);
  const authoredRepo = gitTopLevel(authoredRoot);
  if (!authoredRepo) return rootRepo ? { repoRoot: rootRepo } : null;
  if (rootRepo && authoredRepo === rootRepo && isIgnoredByRepo(rootRepo, authoredRoot)) {
    throw new Error("authored root is ignored by Git but is not a nested Git repository");
  }
  return { repoRoot: authoredRepo };
}

function gitTopLevel(inputPath: string): string | null {
  try {
    return normalizeExistingPath(execFileSync("git", ["-C", inputPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", maxBuffer: gitMaxBuffer, stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch {
    return null;
  }
}

function isIgnoredByRepo(repoRoot: string, candidatePath: string): boolean {
  const relativePath = repoRelativePath(repoRoot, candidatePath);
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", relativePath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function repoRelativePath(repoRoot: string, filePath: string): string {
  const relativePath = path.relative(normalizeExistingPath(repoRoot), normalizeExistingPath(filePath));
  if (relativePath.length === 0) return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error("touched path is outside commit repository");
  }
  return relativePath.split(path.sep).join("/");
}

function normalizeExistingPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (existsSync(resolved)) return realpathSync.native(resolved);

  const pendingSegments: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync.native(current), ...pendingSegments);
}

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Harness Anything",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "harness@example.invalid",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Harness Anything",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "harness@example.invalid"
      }
    });
  } catch (error) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${gitErrorMessage(error)}`);
  }
}

function currentGitHead(rootDir: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8", maxBuffer: gitMaxBuffer }).trim();
  } catch {
    return "no-git-head";
  }
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function gitErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "code" in error && typeof (error as { readonly code?: unknown }).code === "string") {
    const code = (error as { readonly code: string }).code;
    if (code.length > 0) return code;
  }
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text.trim().split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}

function rebuildProjectionHash(rootDir: string): string {
  return hashTaskProjectionRows(rebuildTaskProjection({ rootDir }).rows);
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

function validateOp(rootDir: string, op: WriteOp): void {
  if (op.opId.length === 0) rejectWrite("opId is required");
  if (op.taskId.length === 0) rejectWrite("taskId is required");
  if (op.kind === "package_delete_hard") {
    const payload = toJournalPayload(op);
    if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
      rejectWrite(`hard delete requires reason payload: ${op.opId}`);
    }
    assertHardDeleteAllowed(rootDir, op.taskId);
  }
}

function toJournalError(cause: unknown): WriteError {
  if (cause instanceof WriteLockHeldError) {
    return {
      _tag: "WriteConflict",
      taskId: "unknown",
      owner: cause.message
    };
  }
  if (cause instanceof WriteRejectedError) {
    return {
      _tag: "WriteRejected",
      taskId: "unknown",
      reason: cause.reason
    };
  }
  return {
    _tag: "JournalUnavailable",
    cause
  };
}

function normalizeWriteDocumentPath(documentPath: string): string {
  try {
    return normalizeRelativeDocumentPath(documentPath);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error));
  }
}

function rejectWrite(reason: string): never {
  throw new WriteRejectedError(reason);
}
