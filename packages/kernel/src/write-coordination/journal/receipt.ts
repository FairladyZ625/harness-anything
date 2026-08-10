import type { WriteError } from "../../domain/index.ts";
import type {
  DeterminateFlushReport,
  FlushReason,
  FlushLockHolderSnapshot,
  IndeterminateFlushReport,
  JournalRecordWitnessV1,
  WriteOp
} from "../../ports/write-coordinator.ts";
import type { LockRecord } from "./types.ts";
import { durableFileExists, readDurableState, readFileBytes } from "./durable.ts";

export function reconcileDurableFlush(
  reason: FlushReason,
  ownedOpIds: ReadonlyArray<string>,
  pending: WriteOp[],
  journalPath: string,
  watermarkPath: string,
  rootDir: string
): DeterminateFlushReport | undefined {
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
    watermark: ownedOpIds.at(-1),
    publicationMode: "integrity-domain"
  };
}

export function reconcileDurableExactFlush(
  reason: FlushReason,
  witnesses: ReadonlyArray<JournalRecordWitnessV1>,
  authorizations: Map<string, JournalRecordWitnessV1>,
  pending: WriteOp[],
  journalPath: string,
  watermarkPath: string,
  rootDir: string
): DeterminateFlushReport | undefined {
  const report = reconcileDurableFlush(
    reason,
    witnesses.map((witness) => witness.opId),
    pending,
    journalPath,
    watermarkPath,
    rootDir
  );
  if (!report) return undefined;
  for (const witness of witnesses) authorizations.delete(witness.opId);
  return { ...report, publicationMode: "exact-batch" };
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

export function indeterminateForeignCommitterFlush(
  reason: FlushReason,
  operationIds: readonly [string, ...string[]],
  error: WriteError,
  globalLockPath: string
): IndeterminateFlushReport {
  return {
    status: "indeterminate",
    reason,
    opCount: operationIds.length,
    operationIds,
    cause: {
      kind: "foreign-committer",
      detail: lockConflictDetail(error),
      lockHolder: readFlushLockHolderSnapshot(globalLockPath)
    }
  };
}

function readFlushLockHolderSnapshot(globalLockPath: string): FlushLockHolderSnapshot {
  if (!durableFileExists(globalLockPath)) {
    return {
      status: "missing",
      lockPath: globalLockPath,
      detail: "global lock disappeared while the exhausted flush outcome was being captured"
    };
  }
  try {
    const candidate = JSON.parse(
      Buffer.from(readFileBytes(globalLockPath)).toString("utf8")
    ) as Partial<LockRecord>;
    if (typeof candidate.pid !== "number"
      || typeof candidate.hostname !== "string"
      || typeof candidate.acquiredAt !== "string"
      || typeof candidate.heartbeatAt !== "string") {
      return {
        status: "unreadable",
        lockPath: globalLockPath,
        detail: "global lock record did not contain a complete holder identity"
      };
    }
    return {
      status: "observed",
      lockPath: globalLockPath,
      pid: candidate.pid,
      hostname: candidate.hostname,
      acquiredAt: candidate.acquiredAt,
      heartbeatAt: candidate.heartbeatAt,
      ...(candidate.ownerKind ? { ownerKind: candidate.ownerKind } : {}),
      ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
      ...(candidate.canonicalRoot ? { canonicalRoot: candidate.canonicalRoot } : {}),
      ...(candidate.endpoint ? { endpoint: candidate.endpoint } : {})
    };
  } catch (error) {
    return {
      status: "unreadable",
      lockPath: globalLockPath,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function lockConflictDetail(error: WriteError): string {
  if (error._tag === "GlobalWriteConflict") {
    return error.owner ?? "foreign process still owns the global write lock";
  }
  if (error._tag === "WriteConflict") {
    return error.owner ?? `write lock conflict for ${error.taskId}`;
  }
  return "write outcome remained unknown after the visible retry budget was exhausted";
}
