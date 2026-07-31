import { Effect } from "effect";
import type {
  WriteCoordinator,
  WriteError,
  WriteOp
} from "@harness-anything/kernel";

interface ProjectionWriteHandle {
  readonly settle: () => void;
}

export function makeDeferredAuthorityCoordinator(input: {
  readonly beginProjectionWrite: (op: WriteOp) => ProjectionWriteHandle;
  readonly makeDurableCoordinator: () => WriteCoordinator;
}): WriteCoordinator {
  const pending: WriteOp[] = [];
  const projectionWrites: ProjectionWriteHandle[] = [];
  return {
    enqueue: (op) => Effect.sync(() => {
      projectionWrites.push(input.beginProjectionWrite(op));
      pending.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true as const };
    }),
    flush: (reason) => {
      if (pending.length === 0) return Effect.succeed({ reason, opCount: 0, committed: false });
      const ops = pending.splice(0, pending.length);
      const coordinator = input.makeDurableCoordinator();
      return Effect.forEach(ops, (op) => coordinator.enqueue(op)).pipe(
        Effect.flatMap((acknowledgements) => {
          const witnesses = acknowledgements.flatMap((acknowledgement) =>
            acknowledgement.journalWitness ? [acknowledgement.journalWitness] : []
          );
          if (!coordinator.flushExactJournalRecords || witnesses.length !== ops.length) {
            const witnessedOpIds = new Set(witnesses.map((witness) => witness.opId));
            const missingOpIds = ops
              .map((op) => op.opId)
              .filter((opId) => !witnessedOpIds.has(opId));
            const error: WriteError = {
              _tag: "WriteRejected" as const,
              code: "authority_exact_journal_witness_required",
              reason: "Authority publication requires one exact durable journal witness for every enqueued operation; broad journal flush is forbidden.",
              retryable: false,
              context: { missingOpIds }
            };
            return Effect.fail(error);
          }
          return coordinator.flushExactJournalRecords(reason, witnesses).pipe(
            Effect.map((report) => ({
              ...report,
              publicationMode: "exact-batch" as const
            }))
          );
        }),
        Effect.ensuring(Effect.sync(() => {
          for (const projectionWrite of projectionWrites.splice(0, projectionWrites.length)) {
            projectionWrite.settle();
          }
        }))
      );
    },
    recover: Effect.suspend(() => input.makeDurableCoordinator().recover)
  };
}
