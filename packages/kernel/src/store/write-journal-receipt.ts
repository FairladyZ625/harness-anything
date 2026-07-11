import type { WriteError } from "../domain/index.ts";
import type { FlushReason, FlushReport, WriteOp } from "../ports/write-coordinator.ts";
import { durableFileExists, readDurableState, readFileBytes } from "./write-journal-durable.ts";

export function reconcileDurableFlush(
  reason: FlushReason,
  ownedOpIds: ReadonlyArray<string>,
  pending: WriteOp[],
  journalPath: string,
  watermarkPath: string,
  rootDir: string
): FlushReport | undefined {
  if (ownedOpIds.length === 0) return undefined;
  try {
    const applied = readDurableState(journalPath, watermarkPath, rootDir).applied;
    if (!ownedOpIds.every((opId) => applied.has(opId))) return undefined;
  } catch {
    // A malformed or unreadable durable state can never justify a successful receipt.
    return undefined;
  }
  const owned = new Set(ownedOpIds);
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (owned.has(pending[index]!.opId)) pending.splice(index, 1);
  }
  return {
    reason,
    opCount: ownedOpIds.length,
    committed: true,
    watermark: ownedOpIds.at(-1)
  };
}

export function shouldWaitForForeignCommitter(error: WriteError, globalLockPath: string): boolean {
  if (error._tag !== "GlobalWriteConflict") return false;
  if (!durableFileExists(globalLockPath)) return true;
  try {
    const lock = JSON.parse(Buffer.from(readFileBytes(globalLockPath)).toString("utf8")) as { readonly pid?: unknown };
    return typeof lock.pid !== "number" || lock.pid !== process.pid;
  } catch {
    // The lock owner may still be between open("wx") and its durable JSON write.
    return true;
  }
}
