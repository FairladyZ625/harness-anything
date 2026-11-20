import { processLockHolderDead } from "./process-port.ts";
import { closeSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { consumeKnownError } from "@harness-anything/kernel";
import type { CanonicalRoot } from "./protocol/daemon-protocol.contract.ts";
import { cellCodedError, cellErrorCode, cellErrorMessage } from "./repo-cell-errors.ts";
export { causeClassOf, latchReprobeThrottleMs } from "./repo-cell-cause.ts";

export async function acquireWorkspaceLock(rootDir: CanonicalRoot): Promise<{ readonly close: () => Promise<void> }> {
  const lockPath = `${rootDir}.harness-anything-writer.lock`;
  let descriptor: number | undefined;
  try {
    descriptor = openWriterLockFile(lockPath);
  } catch (error) {
    if (cellErrorCode(error) !== "EEXIST") throw error;
    if (!staleWriterLock(lockPath))
      throw cellCodedError(
        "writer_rejected",
        `Workspace writer lock is held for ${rootDir}: ${cellErrorMessage(error)}`,
      );
    consumeKnownError(error);
  }
  if (descriptor === undefined) {
    /* @gate-identity state-store/execution.workspace-writer-lock */ unlinkSync(lockPath);
    try {
      descriptor = openWriterLockFile(lockPath);
    } catch (error) {
      if (cellErrorCode(error) !== "EEXIST") throw error;
      throw cellCodedError(
        "writer_rejected",
        `Workspace writer lock recovery raced for ${rootDir}: ${cellErrorMessage(error)}`,
      );
    }
  }
  try {
    /* @gate-identity state-store/execution.workspace-writer-lock */ writeFileSync(
      descriptor,
      `${process.pid}\n`,
      "utf8",
    );
  } catch (error) {
    releaseWriterLockFile(descriptor, lockPath);
    throw cellCodedError(
      "writer_rejected",
      `Workspace writer lock could not be initialized for ${rootDir}: ${cellErrorMessage(error)}`,
    );
  }
  const heldDescriptor = descriptor;
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      releaseWriterLockFile(heldDescriptor, lockPath);
    },
  };
}

function openWriterLockFile(lockPath: string): number {
  return /* @gate-identity state-store/execution.workspace-writer-lock */ openSync(lockPath, "wx", 0o600);
}

function releaseWriterLockFile(descriptor: number, lockPath: string): void {
  /* @gate-identity state-store/execution.workspace-writer-lock */ closeSync(descriptor);
  /* @gate-identity state-store/execution.workspace-writer-lock */ rmSync(lockPath, { force: true });
}

export function staleWriterLock(target: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(target, "utf8").trim());
  } catch (error) {
    if (cellErrorCode(error) !== "ENOENT") throw error;
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  return processLockHolderDead(target, pid);
}
