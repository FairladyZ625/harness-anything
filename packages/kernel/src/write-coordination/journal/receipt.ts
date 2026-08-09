import type {
  FlushReason,
  FlushReport,
  JournalRecordWitnessV1,
  WriteOp
} from "../../ports/write-coordinator.ts";
import { readDurableState } from "./durable.ts";

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
): FlushReport | undefined {
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
