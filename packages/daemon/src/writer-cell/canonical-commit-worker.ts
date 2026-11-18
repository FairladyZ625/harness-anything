import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { parentPort, workerData } from "node:worker_threads";
import type { CanonicalEventStore } from "@harness-anything/kernel";
import type { CanonicalCommitCall, CanonicalCommitResponse } from "./canonical-commit-protocol.ts";
import type { SqliteAppendPreparation, WriterEpochFenceDescriptor } from "@harness-anything/storage/sqlite";
import { freezeDeclaredWritePlan } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import type {
  CanonicalEventWriteBundle,
  CanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";

export interface CanonicalCommitBootstrap {
  readonly repoId: string;
  readonly rootDir: string;
  readonly authoredBranch?: string;
  readonly storage?: import("@harness-anything/storage/sqlite").DaemonStorageConfig;
  readonly defaultWriterEpochFence?: WriterEpochFenceDescriptor;
}

/** dec_04A9211B073F29F0FC1E1CA573 CH2: only the selected storage driver enters this isolate. */
export function startCanonicalCommitWorker(adapter: {
  readonly open: (
    config: CanonicalCommitBootstrap,
    fence: () => WriterEpochFenceDescriptor,
  ) => CanonicalEventStore & {
    readonly append: (
      bundle: CanonicalWriteBundle,
      preparation?: SqliteAppendPreparation,
    ) => ReturnType<CanonicalEventStore["append"]>;
    readonly pruneReplicationLog?: (beforeSequence: number) => void;
  };
  readonly withFence: <T>(fence: WriterEpochFenceDescriptor, work: () => T) => T;
  readonly closeFences: () => void;
  readonly withWriteRequest?: <T>(request: NonNullable<CanonicalCommitCall["writeRequest"]>, operation: () => T) => T;
}): void {
  if (!parentPort) throw new Error("Canonical commit entry requires a Worker");
  const config = (workerData as { config: CanonicalCommitBootstrap }).config;
  let activeFence = config.defaultWriterEpochFence;
  const fence = () => {
    if (!activeFence || activeFence.repoId !== config.repoId)
      throw Object.assign(new Error("Canonical commit requires this repository's writer fence"), {
        code: "writer_epoch_stale",
      });
    return activeFence;
  };
  let store: ReturnType<typeof adapter.open> | undefined;
  let closed = false;
  parentPort.on("message", async (call: CanonicalCommitCall) => {
    if ((call as { schema: string })?.schema === "canonical-writer-crash/v1") process.exit(86);
    if (call?.schema !== "canonical-commit/v1") return;
    let response: CanonicalCommitResponse;
    try {
      if (closed) throw new Error("Canonical writer is closed");
      activeFence = call.fence ?? config.defaultWriterEpochFence;
      let value: unknown;
      if (call.request.operation === "close") {
        closed = true;
        if (store) await store.drain();
        adapter.closeFences();
      } else {
        const commit = () => {
          store ??= adapter.open(config, fence);
          const current = store;
          return adapter.withFence(fence(), () => {
            switch (call.request.operation) {
              case "append": {
                // Structured clone drops Object.freeze. Revalidate and refreeze the
                // declaration, as the existing PG transport does, before storage
                // independently validates the event, plan and transaction guards.
                const bundle = call.request.bundle,
                  freeze = (member: CanonicalEventWriteBundle): CanonicalEventWriteBundle => ({
                    ...member,
                    plan: freezeDeclaredWritePlan(member.plan, [member.plan.commandType]),
                  });
                return current.append(
                  {
                    ...freeze(bundle),
                    ...(bundle.preceding ? { preceding: bundle.preceding.map(freeze) } : {}),
                  },
                  call.request.preparation,
                );
              }
              case "reject":
                return current.appendRejection!(call.request.rejection);
              case "prune":
                return current.pruneReplicationLog?.(call.request.beforeSequence);
              default:
                throw Object.assign(new Error("Unsupported canonical commit operation"), { code: "invalid_command" });
            }
          });
        };
        value =
          call.writeRequest && adapter.withWriteRequest
            ? adapter.withWriteRequest(call.writeRequest, commit)
            : commit();
      }
      response = { ok: true, value };
    } catch (error) {
      consumeKnownError(error);
      const failure = error instanceof Error ? error : new Error(String(error));
      response = {
        ok: false,
        error: {
          name: failure.name,
          message: failure.message,
          ...("code" in failure && typeof failure.code === "string" ? { code: failure.code } : {}),
        },
      };
    }
    call.response.postMessage(response);
    call.response.close();
    Atomics.store(call.state, 0, 1);
    Atomics.notify(call.state, 0);
  });
}
