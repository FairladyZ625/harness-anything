import { activeStorageWriteRequest } from "@harness-anything/storage";
import { MessageChannel, receiveMessageOnPort, type Worker } from "node:worker_threads";
import type { CanonicalEventStore } from "@harness-anything/kernel";
import type { SqliteAppendPreparation, WriterEpochFenceDescriptor } from "@harness-anything/storage/sqlite";
import type {
  CanonicalCommitCall,
  CanonicalCommitRequest,
  CanonicalCommitResponse,
} from "../writer-cell/canonical-commit-protocol.ts";

/** Host -> writer commit port. The writer never calls back into the host. */
export function canonicalCommitClient(post: Worker["postMessage"], sharedState?: SharedArrayBuffer) {
  const connection = sharedState ? new Int32Array(sharedState) : undefined;
  let closed = false;
  const call = (request: CanonicalCommitRequest, fence?: WriterEpochFenceDescriptor): unknown => {
    if (closed) throw Object.assign(new Error("Canonical Writer is disconnected"), { code: "daemon_closed" });
    const channel = new MessageChannel(),
      state = connection ?? new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(state, 0, 0);
    try {
      if (connection && Atomics.load(connection, 1) === 0)
        throw Object.assign(new Error("Canonical Writer is disconnected"), { code: "daemon_closed" });
      const context = activeStorageWriteRequest();
      if ("bundle" in request) context?.onOperation?.(request.bundle.event.opId);
      else if ("rejection" in request) context?.onOperation?.(request.rejection.opId);
      post(
        {
          schema: "canonical-commit/v1",
          request,
          state,
          fence,
          response: channel.port2,
          ...(context ? { writeRequest: { state: context.state, id: context.id } } : {}),
        } satisfies CanonicalCommitCall,
        [channel.port2],
      );
      // Storage owns pre-commit cancellation and rollback deadlines. Once PG wins
      // COMMIT its SyncRep wait is unbounded; a second host deadline must not
      // detach that physical owner. Writer exit wakes this wait through connection.
      Atomics.wait(state, 0, 0);
      if (Atomics.load(state, 0) === -1)
        throw Object.assign(new Error("Canonical Writer exited before acknowledging its commit"), {
          code: "publication_indeterminate",
          ...("bundle" in request ? { opId: request.bundle.event.opId } : {}),
        });
      const response = receiveMessageOnPort(channel.port1)?.message as CanonicalCommitResponse | undefined;
      if (!response) throw new Error("Canonical commit Worker omitted its response");
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      return response.value;
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  };
  return {
    forFence: (writerFence: () => WriterEpochFenceDescriptor) => ({
      append: (bundle: Parameters<CanonicalEventStore["append"]>[0], preparation?: SqliteAppendPreparation) =>
        call({ operation: "append", bundle, ...(preparation ? { preparation } : {}) }, writerFence()) as ReturnType<
          CanonicalEventStore["append"]
        >,
      appendRejection: (rejection: Parameters<NonNullable<CanonicalEventStore["appendRejection"]>>[0]) =>
        call({ operation: "reject", rejection }, writerFence()) as ReturnType<
          NonNullable<CanonicalEventStore["appendRejection"]>
        >,
      pruneReplicationLog: (beforeSequence: number) => {
        call({ operation: "prune", beforeSequence }, writerFence());
      },
    }),
    close: () => {
      if (closed) return;
      call({ operation: "close" });
      closed = true;
    },
    abandon: () => {
      closed = true;
    },
  };
}
