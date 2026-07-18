import { Effect } from "effect";
import type { WriteCoordinator, WriteOp } from "../ports/write-coordinator.ts";

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
      return Effect.forEach(ops, (op) => coordinator.enqueue(op), { discard: true }).pipe(
        Effect.flatMap(() => coordinator.flush(reason)),
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
