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
  LockConflictRetryOptions,
  OwnedLock,
  ReadableJournalRecord,
  JournalRecordV1,
  WriteWatermark
} from "./types.ts";
import { isWriteLockConflict, retryWriteLockConflict } from "./lock-conflict-retry.ts";

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
  return flushExactAuthorizedJournalRecords({
    ...input,
    witnesses: [input.witness],
    flushRecords: (state, records) => input.flushRecord(state, records[0]!)
  });
}

export function flushExactAuthorizedJournalRecords(input: {
  readonly rootDir: string;
  readonly rootInput: HarnessLayoutInput;
  readonly journalPath: string;
  readonly watermarkPath: string;
  readonly operationalActor: OperationalActor;
  readonly lockTtlMs: number;
  readonly heldGlobalLock?: OwnedLock;
  readonly witnesses: ReadonlyArray<JournalRecordWitnessV1>;
  readonly authorizations: Map<string, JournalRecordWitnessV1>;
  readonly pending: WriteOp[];
  readonly flushRecords: (
    state: {
      readonly watermark: WriteWatermark | null;
      readonly fileApplied: ReadonlySet<string>;
    },
    records: ReadonlyArray<ReadableJournalRecord>
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
      if (input.witnesses.length === 0) {
        rejectWrite("exact journal publication requires at least one witness");
      }
      const opIds = new Set(input.witnesses.map((witness) => witness.opId));
      if (opIds.size !== input.witnesses.length) {
        rejectWrite("exact journal publication witnesses must be unique");
      }
      for (const witness of input.witnesses) {
        const authorized = input.authorizations.get(witness.opId);
        if (!authorized
          || authorized.schema !== witness.schema
          || authorized.recordDigest !== witness.recordDigest) {
          rejectWrite(`exact journal witness is not authorized: ${witness.opId}`);
        }
      }
      const state = readDurableState(
        input.journalPath,
        input.watermarkPath,
        input.rootDir
      );
      const records = input.witnesses.map((witness) => {
        const record = state.records.find(
          (candidate) => candidate.opId === witness.opId
        );
        if (!record) rejectWrite(`exact journal record is missing: ${witness.opId}`);
        if (journalRecordWitnessV1(record).recordDigest !== witness.recordDigest) {
          rejectWrite(
            `exact journal witness does not match durable record: ${witness.opId}`
          );
        }
        return record;
      });
      const report = input.flushRecords(state, records);
      for (const witness of input.witnesses) {
        const pendingIndex = input.pending.findIndex(
          (operation) => operation.opId === witness.opId
        );
        if (pendingIndex >= 0) input.pending.splice(pendingIndex, 1);
        input.authorizations.delete(witness.opId);
      }
      return { ...report, publicationMode: "exact-batch" };
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
  readonly lockConflictRetry?: LockConflictRetryOptions;
  readonly reconcileDurable?: (
    reason: "recovery",
    witnesses: ReadonlyArray<JournalRecordWitnessV1>
  ) => FlushReport | undefined;
  readonly shouldContinueAfterTimeout?: (error: WriteError) => boolean;
}): NonNullable<import("../../ports/write-coordinator.ts").WriteCoordinator[
  "flushExactJournalRecord"
]> {
  return (reason, witness) => {
    const exactWitness = Object.freeze({ ...witness });
    return input.finish(runExactFlush({
      run: () => input.run(reason, exactWitness),
      mapError: input.mapError,
      ...(input.lockConflictRetry ? { lockConflictRetry: input.lockConflictRetry } : {}),
      ...(input.reconcileDurable ? {
        reconcileDurable: () => input.reconcileDurable!(reason, [exactWitness])
      } : {}),
      ...(input.shouldContinueAfterTimeout
        ? { shouldContinueAfterTimeout: input.shouldContinueAfterTimeout }
        : {})
    }));
  };
}

export function createExactJournalRecordsFlusher(input: {
  readonly run: (
    reason: import("../../ports/write-coordinator.ts").FlushReason,
    witnesses: ReadonlyArray<JournalRecordWitnessV1>
  ) => FlushReport;
  readonly mapError: (cause: unknown) => WriteError;
  readonly finish: (
    effect: Effect.Effect<FlushReport, WriteError>
  ) => Effect.Effect<FlushReport, WriteError>;
  readonly lockConflictRetry?: LockConflictRetryOptions;
  readonly reconcileDurable?: (
    reason: import("../../ports/write-coordinator.ts").FlushReason,
    witnesses: ReadonlyArray<JournalRecordWitnessV1>
  ) => FlushReport | undefined;
  readonly shouldContinueAfterTimeout?: (error: WriteError) => boolean;
}): NonNullable<import("../../ports/write-coordinator.ts").WriteCoordinator[
  "flushExactJournalRecords"
]> {
  return (reason, witnesses) => {
    const exactWitnesses = Object.freeze(witnesses.map((witness) => Object.freeze({ ...witness })));
    return input.finish(runExactFlush({
      run: () => input.run(reason, exactWitnesses),
      mapError: input.mapError,
      ...(input.lockConflictRetry ? { lockConflictRetry: input.lockConflictRetry } : {}),
      ...(input.reconcileDurable ? {
        reconcileDurable: () => input.reconcileDurable!(reason, exactWitnesses)
      } : {}),
      ...(input.shouldContinueAfterTimeout
        ? { shouldContinueAfterTimeout: input.shouldContinueAfterTimeout }
        : {})
    }));
  };
}

function runExactFlush(input: {
  readonly run: () => FlushReport;
  readonly mapError: (cause: unknown) => WriteError;
  readonly lockConflictRetry?: LockConflictRetryOptions;
  readonly reconcileDurable?: () => FlushReport | undefined;
  readonly shouldContinueAfterTimeout?: (error: WriteError) => boolean;
}): Effect.Effect<FlushReport, WriteError> {
  const runOnce = (): Effect.Effect<FlushReport, WriteError> => Effect.try({
    try: input.run,
    catch: input.mapError
  });
  if (input.lockConflictRetry) {
    return retryWriteLockConflict(
      runOnce,
      input.lockConflictRetry,
      Date.now(),
      0,
      input.reconcileDurable,
      input.shouldContinueAfterTimeout
    );
  }
  return runOnce().pipe(Effect.catchAll((error) => {
    const reconciled = isWriteLockConflict(error) ? input.reconcileDurable?.() : undefined;
    return reconciled ? Effect.succeed(reconciled) : Effect.fail(error);
  }));
}
import { Effect } from "effect";
import type { WriteError } from "../../domain/index.ts";
