import type {
  FlushReport,
  JournalRecordWitnessV1,
  WriteAck,
  WriteOp
} from "../../ports/write-coordinator.ts";
import type { HarnessLayoutInput } from "../../layout/index.ts";
import { readDurableState } from "./durable.ts";
import { withRepoLocks } from "./locks.ts";
import { journalRecordWitnessV1 } from "./records.ts";
import { rejectWrite } from "./rejection.ts";
import type {
  OperationalActor,
  OwnedLock,
  ReadableJournalRecord,
  JournalRecordV1,
  WriteWatermark
} from "./types.ts";

export function authorizeExactJournalRecord(
  record: ReadableJournalRecord | JournalRecordV1,
  entityId: WriteOp["entityId"],
  authorizations: Map<string, JournalRecordWitnessV1>
): WriteAck {
  const journalWitness = journalRecordWitnessV1(record);
  authorizations.set(record.opId, journalWitness);
  return { opId: record.opId, entityId, accepted: true, journalWitness };
}

export function flushExactAuthorizedJournalRecord(input: {
  readonly rootDir: string;
  readonly rootInput: HarnessLayoutInput;
  readonly journalPath: string;
  readonly watermarkPath: string;
  readonly operationalActor: OperationalActor;
  readonly lockTtlMs: number;
  readonly heldGlobalLock?: OwnedLock;
  readonly witness: JournalRecordWitnessV1;
  readonly authorizations: Map<string, JournalRecordWitnessV1>;
  readonly pending: WriteOp[];
  readonly flushRecord: (
    state: {
      readonly watermark: WriteWatermark | null;
      readonly fileApplied: ReadonlySet<string>;
    },
    record: ReadableJournalRecord
  ) => FlushReport;
}): FlushReport {
  return withRepoLocks(
    input.rootDir,
    input.rootInput,
    input.journalPath,
    input.operationalActor,
    input.lockTtlMs,
    [],
    () => {
      const authorized = input.authorizations.get(input.witness.opId);
      if (!authorized
        || authorized.schema !== input.witness.schema
        || authorized.recordDigest !== input.witness.recordDigest) {
        rejectWrite(`exact journal witness is not authorized: ${input.witness.opId}`);
      }
      const state = readDurableState(
        input.journalPath,
        input.watermarkPath,
        input.rootDir
      );
      const record = state.records.find(
        (candidate) => candidate.opId === input.witness.opId
      );
      if (!record) rejectWrite(`exact journal record is missing: ${input.witness.opId}`);
      if (journalRecordWitnessV1(record).recordDigest !== input.witness.recordDigest) {
        rejectWrite(
          `exact journal witness does not match durable record: ${input.witness.opId}`
        );
      }
      const report = input.flushRecord(state, record);
      const pendingIndex = input.pending.findIndex(
        (operation) => operation.opId === input.witness.opId
      );
      if (pendingIndex >= 0) input.pending.splice(pendingIndex, 1);
      input.authorizations.delete(input.witness.opId);
      return report;
    },
    { heldGlobalLock: input.heldGlobalLock }
  );
}

export function createExactJournalRecordFlusher(input: {
  readonly run: (
    reason: "recovery",
    witness: JournalRecordWitnessV1
  ) => FlushReport;
  readonly mapError: (cause: unknown) => WriteError;
  readonly finish: (
    effect: Effect.Effect<FlushReport, WriteError>
  ) => Effect.Effect<FlushReport, WriteError>;
}): NonNullable<import("../../ports/write-coordinator.ts").WriteCoordinator[
  "flushExactJournalRecord"
]> {
  return (reason, witness) => input.finish(Effect.try({
    try: () => input.run(reason, witness),
    catch: input.mapError
  }));
}
import { Effect } from "effect";
import type { WriteError } from "../../domain/index.ts";
