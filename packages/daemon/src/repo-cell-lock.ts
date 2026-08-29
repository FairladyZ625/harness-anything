import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { VcsCommandError, consumeKnownError } from "../../kernel/src/index.ts";
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
    ["writer_rejected", "publication_indeterminate"].includes(cellErrorCode(error))
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

export function staleWriterLock(target: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(target, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}
