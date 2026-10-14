import { runFleetReplicaStream, type FleetReplicaStreamOptions } from "./peer.ts";
import { readReplicaGeneration } from "./replica-generation.ts";
import { recordReplicaHealth, replicaFailure } from "./replica-health.ts";
export interface ReplicaSyncOptions extends Omit<FleetReplicaStreamOptions, "onApplied"> {
  readonly signal?: AbortSignal;
  /** Runs after each acknowledged position, before receiving the next replication frame. */
  readonly onConfirmed?: () => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void;
}
type Waiter = { readonly sequence: number; readonly resolve: () => void; readonly reject: (error: unknown) => void };
const waiters = new Map<string, Set<Waiter>>();
/** Running streams by key; `down` holds the last failure until the next connection attempt. */
const streams = new Map<string, { down: unknown }>();
const syncKey = (options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">): string =>
  `${options.viewRoot}\u0000${options.repoId}\u0000${options.nodeId}`;
export class FleetReplicaStreamDownError extends Error {
  readonly code = "replica_stream_down";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
const streamDown = (cause: unknown): FleetReplicaStreamDownError =>
  new FleetReplicaStreamDownError(
    `replica stream is down: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  );
const settle = (key: string, sequence: number | null, failure?: unknown): void => {
  const pending = waiters.get(key);
  if (!pending) return;
  for (const waiter of [...pending])
    if (failure !== undefined) {
      pending.delete(waiter);
      waiter.reject(failure);
    } else if (sequence !== null && sequence >= waiter.sequence) {
      pending.delete(waiter);
      waiter.resolve();
    }
  if (pending.size === 0) waiters.delete(key);
};
/**
 * Write-then-read: resolves once the resident stream applied the center commit sequence of a write.
 * It fails instead of waiting while no stream runs for the view or the stream is down, and when the
 * stream fails or stops before reaching the sequence; the caller's signal cancels it.
 */
export function waitForFleetReplicaSequence(
  options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">,
  sequence: number,
  signal?: AbortSignal,
): Promise<void> {
  const current = readReplicaGeneration(`${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`);
  if (current && current.metadata.position.sequence >= sequence) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason);
  const key = syncKey(options),
    stream = streams.get(key);
  if (!stream) return Promise.reject(new FleetReplicaStreamDownError("replica stream is not running"));
  if (stream.down !== null) return Promise.reject(streamDown(stream.down));
  return new Promise<void>((resolve, reject) => {
    const pending = waiters.get(key) ?? new Set<Waiter>();
    const waiter: Waiter = {
      sequence,
      resolve: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    };
    const onAbort = () => {
      pending.delete(waiter);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.add(waiter);
    waiters.set(key, pending);
  });
}
/** One long-lived stream per node and repository; it reconnects with backoff only after a failure. */
export async function runFleetReplicaSync(options: ReplicaSyncOptions): Promise<void> {
  const key = syncKey(options),
    stream = { down: null as unknown },
    viewDir = `${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`;
  const observe = (syncFailure: { readonly code: string; readonly message: string } | null): void =>
    recordReplicaHealth(viewDir, { syncFailure });
  streams.set(key, stream);
  let failures = 0;
  try {
    while (!options.signal?.aborted) {
      stream.down = null;
      const attempt = await runSyncAttempt({
        ...options,
        onApplied: async (position) => {
          failures = 0;
          observe(null);
          settle(key, position.sequence);
          await options.onConfirmed?.();
        },
      });
      if (options.signal?.aborted) return;
      if (attempt.failed) {
        stream.down = attempt.error;
        observe(replicaFailure(attempt.error, "replica_sync_failed"));
        settle(key, null, streamDown(attempt.error));
        options.onFailure?.(attempt.error);
      }
      const ceiling = Math.min(30_000, 250 * 2 ** Math.min(failures++, 7));
      const delay = Math.floor(Math.random() * (ceiling + 1));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay),
          onAbort = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    if (streams.get(key) === stream) streams.delete(key);
    settle(key, null, new FleetReplicaStreamDownError("replica stream stopped"));
  }
}

/** A failed session is an explicit result for the resident owner's reconnect loop. */
async function runSyncAttempt(
  options: FleetReplicaStreamOptions,
): Promise<{ readonly failed: false } | { readonly failed: true; readonly error: unknown }> {
  try {
    await runFleetReplicaStream(options);
    return { failed: false };
  } catch (error) {
    return { failed: true, error };
  }
}
