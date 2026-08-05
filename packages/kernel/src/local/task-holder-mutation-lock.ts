import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { isConcurrentRenameLoss, localRuntimeStateFileSystem } from "./local-layout-file-system.ts";

interface TaskHolderMutationLockRecord {
  readonly schema: "task-holder-mutation-lock/v1";
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly ownerToken: string;
}

const mutationLockRetryMs = 5;
const mutationLockWaitMs = 5_000;
const mutationLockStaleMs = 30_000;

export async function withTaskHolderMutationLock<Result>(
  rootInput: HarnessLayoutInput,
  taskId: string,
  run: () => Result | Promise<Result>
): Promise<Result> {
  const lockPath = `${taskHolderRecordPath(rootInput, taskId)}.lock`;
  const ownerToken = await acquireTaskHolderMutationLock(lockPath, taskId);
  try {
    return await run();
  } finally {
    releaseTaskHolderMutationLock(lockPath, ownerToken);
  }
}

export function taskHolderRecordPath(rootInput: HarnessLayoutInput, taskId: string): string {
  if (!/^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u.test(taskId)) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  return path.join(resolveHarnessLayout(rootInput).localRoot, "task-holders", `${taskId}.json`);
}

async function acquireTaskHolderMutationLock(lockPath: string, taskId: string): Promise<string> {
  const ownerToken = randomBytes(12).toString("hex");
  const startedAt = Date.now();
  localRuntimeStateFileSystem.mkdirp(path.dirname(lockPath));
  while (Date.now() - startedAt <= mutationLockWaitMs) {
    const record: TaskHolderMutationLockRecord = {
      schema: "task-holder-mutation-lock/v1",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      ownerToken
    };
    if (localRuntimeStateFileSystem.createExclusiveText(lockPath, JSON.stringify(record))) {
      clearTaskHolderMutationLockReleaseMarkers(lockPath);
      return ownerToken;
    }
    recoverAbandonedTaskHolderMutationLock(lockPath);
    await new Promise<void>((resolve) => setTimeout(resolve, mutationLockRetryMs));
  }
  throw new Error(`timed out waiting for task holder mutation lock: ${taskId}`);
}

function recoverAbandonedTaskHolderMutationLock(lockPath: string): void {
  let record: TaskHolderMutationLockRecord | null;
  try {
    record = readTaskHolderMutationLock(lockPath);
  } catch (error) {
    if (isConcurrentWindowsLockAccess(error)) return;
    throw error;
  }
  const releaseMarkerPath = record ? taskHolderMutationLockReleaseMarkerPath(lockPath, record.ownerToken) : null;
  const released = releaseMarkerPath ? localRuntimeStateFileSystem.exists(releaseMarkerPath) : false;
  const modifiedAtMs = record ? null : readTaskHolderMutationLockModifiedAtMs(lockPath);
  const acquiredAtMs = record ? Date.parse(record.acquiredAt) : modifiedAtMs;
  if (acquiredAtMs === null) return;
  const ageMs = Date.now() - acquiredAtMs;
  const abandoned = released || (record?.hostname === hostname()
    ? !processIsAlive(record.pid)
    : Number.isFinite(ageMs) && ageMs > mutationLockStaleMs);
  if (!abandoned) return;
  const quarantinePath = `${lockPath}.stale.${randomBytes(6).toString("hex")}`;
  try {
    localRuntimeStateFileSystem.rename(lockPath, quarantinePath);
    localRuntimeStateFileSystem.remove(quarantinePath);
    if (releaseMarkerPath) localRuntimeStateFileSystem.remove(releaseMarkerPath);
  } catch (error) {
    if (!isMissingFileError(error) && !isConcurrentRenameLoss(error)) throw error;
  }
}

function readTaskHolderMutationLockModifiedAtMs(lockPath: string): number | null {
  try {
    return localRuntimeStateFileSystem.modifiedAtMs(lockPath);
  } catch (error) {
    if (isMissingFileError(error) || isConcurrentWindowsLockAccess(error)) return null;
    throw error;
  }
}

function releaseTaskHolderMutationLock(lockPath: string, ownerToken: string): void {
  let record: TaskHolderMutationLockRecord | null;
  try {
    record = readTaskHolderMutationLock(lockPath);
  } catch (error) {
    if (isConcurrentWindowsLockAccess(error)) {
      // Carry ownership across the sharing violation; recovery only acts on a matching lock generation.
      localRuntimeStateFileSystem.writeText(taskHolderMutationLockReleaseMarkerPath(lockPath, ownerToken), "");
      return;
    }
    throw error;
  }
  if (record?.ownerToken === ownerToken) localRuntimeStateFileSystem.remove(lockPath);
}

function taskHolderMutationLockReleaseMarkerPath(lockPath: string, ownerToken: string): string {
  return `${lockPath}.release.${ownerToken}`;
}

function clearTaskHolderMutationLockReleaseMarkers(lockPath: string): void {
  const directoryPath = path.dirname(lockPath);
  const markerPrefix = `${path.basename(lockPath)}.release.`;
  try {
    for (const entry of localRuntimeStateFileSystem.readNames(directoryPath)) {
      if (entry.startsWith(markerPrefix)) localRuntimeStateFileSystem.remove(path.join(directoryPath, entry));
    }
  } catch {
    // Markers belong to older generations and are safe to leave for the next acquisition.
  }
}

function readTaskHolderMutationLock(lockPath: string): TaskHolderMutationLockRecord | null {
  try {
    const parsed = JSON.parse(localRuntimeStateFileSystem.readText(lockPath)) as Partial<TaskHolderMutationLockRecord>;
    return parsed.schema === "task-holder-mutation-lock/v1" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.acquiredAt === "string" &&
      typeof parsed.ownerToken === "string"
      ? parsed as TaskHolderMutationLockRecord
      : null;
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeErrorCode(error, "ESRCH");
  }
}

function isMissingFileError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT");
}

function isConcurrentWindowsLockAccess(error: unknown): boolean {
  // Callers already know this failed operation targeted the mutation lock; a later exists check would be racy.
  return process.platform === "win32" &&
    isNodeErrorCode(error, "EPERM");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
