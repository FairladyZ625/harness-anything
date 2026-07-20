import type { FlushReport, RecoveryReport } from "../../../ports/write-coordinator.ts";
import { readDurableState } from "../durable.ts";
import { uniquePendingRecords } from "../records.ts";
import type { ReadableJournalRecord } from "../types.ts";
import { writeIntegrityDomain, writeIntegrityDomainsInOrder } from "../integrity-domain.ts";

type DurableState = ReturnType<typeof readDurableState>;

export function recoverJournalIntegrityDomains(input: {
  readonly rootDir: string;
  readonly journalPath: string;
  readonly watermarkPath: string;
  readonly flushDomain: (
    state: DurableState,
    records: ReadonlyArray<ReadableJournalRecord>
  ) => FlushReport;
}): RecoveryReport {
  const initialState = readDurableState(input.journalPath, input.watermarkPath, input.rootDir);
  const initialPending = uniquePendingRecords(initialState.records, initialState.applied);
  let replayedOps = 0;
  let deferredOps = 0;
  let recoveredWatermark: string | undefined;
  for (const domain of writeIntegrityDomainsInOrder(initialPending)) {
    const state = readDurableState(input.journalPath, input.watermarkPath, input.rootDir);
    const records = uniquePendingRecords(state.records, state.applied)
      .filter((record) => writeIntegrityDomain(record) === domain);
    if (records.length === 0) continue;
    try {
      const report = input.flushDomain(state, records);
      replayedOps += report.opCount;
      recoveredWatermark = report.watermark ?? recoveredWatermark;
    } catch {
      deferredOps += records.length;
    }
  }
  return {
    replayedOps,
    ...(recoveredWatermark ? { recoveredWatermark } : {}),
    ...(deferredOps > 0 ? { deferredOps } : {})
  };
}
