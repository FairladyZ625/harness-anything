import { Effect } from "effect";
import {
  withExactCommit,
  type ExactWriteCoordinator,
  type ExactWriteScope,
  type WriteCoordinator,
  type WriteError,
  type WriteOp
} from "@harness-anything/kernel";

interface ProjectionWriteHandle {
  readonly settle: () => void;
}

interface PendingAuthorityWrite {
  readonly operation: WriteOp;
  readonly acknowledgement: {
    readonly opId: string;
    readonly entityId: WriteOp["entityId"];
    readonly accepted: true;
  };
  readonly projectionWrite: ProjectionWriteHandle;
  readonly makeDurableCoordinator: () => WriteCoordinator;
}

const pendingByScope = new WeakMap<ExactWriteScope, Map<string, PendingAuthorityWrite>>();

export function makeDeferredAuthorityCoordinator(input: {
  readonly beginProjectionWrite: (op: WriteOp) => ProjectionWriteHandle;
  readonly makeDurableCoordinator: () => WriteCoordinator;
  readonly exactWriteScope: ExactWriteScope;
}): ExactWriteCoordinator {
  const pending = scopedPendingWrites(input.exactWriteScope);
  const coordinator = {
    enqueue: (op: WriteOp) => Effect.sync(() => {
      if (pending.has(op.opId)) {
        throw new Error(`authority exact coordinator already contains operation: ${op.opId}`);
      }
      const acknowledgement = { opId: op.opId, entityId: op.entityId, accepted: true as const };
      pending.set(op.opId, {
        operation: op,
        acknowledgement,
        projectionWrite: input.beginProjectionWrite(op),
        makeDurableCoordinator: input.makeDurableCoordinator
      });
      return acknowledgement;
    }),
    recover: Effect.suspend(() => input.makeDurableCoordinator().recover)
  };
  return withExactCommit(coordinator, (reason, acknowledgements) => Effect.suspend(() => {
    const selected = acknowledgements.map((acknowledgement) => pending.get(acknowledgement.opId));
    if (selected.some((entry, index) => !entry || entry.acknowledgement !== acknowledgements[index])) {
      const error: WriteError = {
        _tag: "WriteRejected",
        code: "authority_exact_batch_member_missing",
        reason: "Authority exact batch contains an operation that is not pending in this coordinator.",
        retryable: false
      };
      return Effect.fail(error);
    }
    const owned = selected as Array<NonNullable<(typeof selected)[number]>>;
    for (const entry of owned) pending.delete(entry.operation.opId);
    const durableEntries = owned.map((entry) => ({
      entry,
      coordinator: entry.makeDurableCoordinator()
    }));
    return Effect.forEach(durableEntries, ({ entry, coordinator }) => coordinator.enqueue(entry.operation)).pipe(
      Effect.flatMap((durableAcknowledgements) => {
        const witnesses = durableAcknowledgements.flatMap((acknowledgement) =>
          acknowledgement.journalWitness ? [acknowledgement.journalWitness] : []
        );
        const coordinator = durableEntries[0]!.coordinator;
        if (!coordinator.flushExactJournalRecords || witnesses.length !== owned.length) {
          const witnessedOpIds = new Set(witnesses.map((witness) => witness.opId));
          const missingOpIds = owned
            .map((entry) => entry.operation.opId)
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
        for (const entry of owned) entry.projectionWrite.settle();
      }))
    );
  }), input.exactWriteScope);
}

function scopedPendingWrites(scope: ExactWriteScope): Map<string, PendingAuthorityWrite> {
  const existing = pendingByScope.get(scope);
  if (existing) return existing;
  const created = new Map<string, PendingAuthorityWrite>();
  pendingByScope.set(scope, created);
  return created;
}
