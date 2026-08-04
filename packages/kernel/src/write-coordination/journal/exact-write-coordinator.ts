import { Effect } from "effect";
import {
  withExactCommit,
  type ExactCapableWriteCoordinator,
  type ExactWriteScope,
  type JournalRecordWitnessV1,
  type WriteCoordinator,
  type WriteOp
} from "../../ports/write-coordinator.ts";

const scopedExactJournalAuthorizations = new WeakMap<
  ExactWriteScope,
  Map<string, JournalRecordWitnessV1>
>();

export function exactJournalAuthorizationsFor(
  scope: ExactWriteScope
): Map<string, JournalRecordWitnessV1> {
  const existing = scopedExactJournalAuthorizations.get(scope);
  if (existing) return existing;
  const created = new Map<string, JournalRecordWitnessV1>();
  scopedExactJournalAuthorizations.set(scope, created);
  return created;
}

export function createJournalCoordinatorWriteState(scope?: ExactWriteScope): {
  readonly pending: WriteOp[];
  readonly exactJournalAuthorizations: Map<string, JournalRecordWitnessV1>;
} {
  return {
    pending: [],
    exactJournalAuthorizations: scope ? exactJournalAuthorizationsFor(scope) : new Map()
  };
}

export function withJournalExactCommit(
  coordinator: WriteCoordinator,
  flushExactJournalRecords: NonNullable<WriteCoordinator["flushExactJournalRecords"]>,
  scope?: ExactWriteScope
): ExactCapableWriteCoordinator {
  return withExactCommit(coordinator, (reason, acknowledgements) => {
    const witnesses = acknowledgements.flatMap((acknowledgement) =>
      acknowledgement.journalWitness ? [acknowledgement.journalWitness] : []
    );
    if (witnesses.length !== acknowledgements.length) {
      return Effect.fail({
        _tag: "WriteRejected",
        code: "authority_exact_journal_witness_required",
        reason: "Exact publication requires one durable journal witness for every accepted operation.",
        retryable: false
      });
    }
    return flushExactJournalRecords(reason, witnesses);
  }, scope);
}
