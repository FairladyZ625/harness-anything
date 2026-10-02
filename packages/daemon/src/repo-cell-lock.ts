import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { runProcessText } from "./process-port.ts";
import { VcsCommandError, consumeKnownError } from "@harness-anything/kernel";
import { type CanonicalRoot } from "./protocol/daemon-protocol.contract.ts";
import { cellCodedError, cellErrorCode, cellErrorMessage } from "./repo-cell-errors.ts";

const projectionFailurePatterns = [
  /document projection mismatch/iu,
  /projection cache ledger identity mismatch/iu,
  /projection (?:rebuild did not reach|digest refresh lost|snapshot mismatch)/iu,
];

/** Ledger-shape judgments (layout, projection replay, revision bases) point the repair at the data;
 * Git/lock failures (publication CAS, writer lock) point it at the workspace infrastructure. */
export function causeClassOf(error: unknown): "data-shape" | "infrastructure" | "projection" {
  return error instanceof VcsCommandError ||
    ["writer_rejected", "publication_indeterminate", "repo_attach_revoked"].includes(cellErrorCode(error))
    ? "infrastructure"
    : error instanceof Error && projectionFailurePatterns.some((pattern) => pattern.test(error.message))
      ? "projection"
      : "data-shape";
}

export const latchReprobeThrottleMs = 5_000;

export async function acquireWorkspaceLock(rootDir: CanonicalRoot): Promise<{ readonly close: () => Promise<void> }> {
  const lockPath = `${rootDir}.harness-anything-writer.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (!staleWriterLock(lockPath))
      throw cellCodedError(
        "writer_rejected",
        `Workspace writer lock is held for ${rootDir}: ${cellErrorMessage(error)}`,
      );
    consumeKnownError(error);
    unlinkSync(lockPath);
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (retry) {
      throw cellCodedError(
        "writer_rejected",
        `Workspace writer lock recovery raced for ${rootDir}: ${cellErrorMessage(retry)}`,
      );
    }
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (cleanupError) {
      if (cellErrorCode(cleanupError) !== "ENOENT") throw cleanupError;
      consumeKnownError(cleanupError);
    }
    throw cellCodedError(
      "writer_rejected",
      `Workspace writer lock could not be initialized for ${rootDir}: ${cellErrorMessage(error)}`,
    );
  }
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (cellErrorCode(error) === "ENOENT") {
          consumeKnownError(error);
          return;
        }
        throw error;
      }
    },
  };
}

/**
 * Whether an existing writer lock was left behind by a daemon that is gone.
 *
 * `process.kill(pid, 0)` only proves that *some* process holds that pid: Windows reuses pids,
 * so a crashed daemon's lock can look live forever (observed: one crashed daemon left five
 * locks naming a pid that svchost had since taken over, and every one of those repos reported
 * "writer lock is held" until the files were removed by hand).
 *
 * A live pid alone must not prove liveness either: external writers (and a previous daemon
 * generation) legitimately hold locks while a new daemon boots. The only sound recycle signal
 * is ordering — a pid assigned *after* the lock was written cannot be its author — so a lock
 * is stale exactly when its holder started after its mtime. Anything unknowable (unreadable
 * pid, unreadable start time, unreadable lock) stays live: failing closed risks an
 * unavailable repo, while stealing a live lock risks two writers.
 */
export function staleWriterLock(target: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(target, "utf8").trim());
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    // ESRCH proves the holder is gone. Anything else (EPERM for a system pid on Windows,
    // unexpected failures) only proves we cannot signal it, so fall through to the recycle
    // check instead of trusting liveness.
    if (code === "ESRCH") return true;
    if (code !== "EPERM") return false;
    consumeKnownError(error);
  }
  return lockPidRecycled(target, pid);
}

/** Pure recycle predicate, exported for unit tests: a holder born after the lock cannot own it. */
export function lockPidRecycled(lockPath: string, pid: number): boolean {
  const holderStartedAtMs = processStartTimeMs(pid);
  if (holderStartedAtMs === null) return false;
  try {
    return isRecycledPidLock(statSync(lockPath).mtimeMs, holderStartedAtMs);
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
}

/** A pid assigned after the lock was written cannot be its author. Equal timestamps stay live. */
export function isRecycledPidLock(lockMtimeMs: number, holderStartMs: number): boolean {
  return holderStartMs > lockMtimeMs;
}

/** Start time of a live pid in epoch milliseconds, or null when it cannot be determined. */
export function processStartTimeMs(pid: number): number | null {
  try {
    if (process.platform === "linux") return linuxProcessStartTimeMs(pid);
    if (process.platform === "win32") return windowsProcessStartTimeMs(pid);
    return psProcessStartTimeMs(pid);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** /proc pid directories carry the process start time; pure filesystem, no spawn. */
function linuxProcessStartTimeMs(pid: number): number | null {
  try {
    return statSync(`/proc/${pid}`).mtimeMs;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** PowerShell can read start times even for pids we may not signal (e.g. svchost). */
function windowsProcessStartTimeMs(pid: number): number | null {
  try {
    const output = runProcessText(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
      undefined,
      undefined,
      8_000,
    );
    const fileTime = BigInt(output.trim());
    // FILETIME ticks (100ns since 1601) exceed the safe-integer range, so the epoch
    // translation stays in BigInt until it is back in millisecond scale.
    if (fileTime <= 0n) return null;
    return Number(fileTime / 10_000n - 11_644_473_600_000n);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** Portable fallback for darwin and other POSIX hosts. */
function psProcessStartTimeMs(pid: number): number | null {
  try {
    const parsed = Date.parse(
      runProcessText("ps", ["-o", "lstart=", "-p", String(pid)], undefined, undefined, 8_000).trim(),
    );
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
