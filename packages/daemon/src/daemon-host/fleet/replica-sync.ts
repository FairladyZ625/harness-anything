import { consumeKnownError } from "@harness-anything/kernel";
import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { runDaemonRetry } from "../daemon-retry.ts";
import { deterministicReplicaConfirmFailure } from "../runtime-recovery-watch.ts";
import { runFleetReplicaStream, type FleetReplicaStreamOptions } from "./peer.ts";
import { readReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { recordReplicaHealth, replicaFailure } from "../../fleet-sync/fleet/replica-health.ts";
import { isDeterministicReplicaFailure, replicaRetryDelay } from "../../fleet-sync/fleet/replica-retry.ts";
const DEFAULT_CONFIRM_TIMEOUT_MS = daemonProtocolFleetPolicy.defaultValue.fleet.replicationIdleTimeoutMs;
export interface ReplicaSyncOptions extends Omit<FleetReplicaStreamOptions, "onApplied"> {
  readonly signal?: AbortSignal;
  /** Daemon lifetime ends confirmation work even when an edge stream is being drained. */
  readonly shutdownSignal?: AbortSignal;
  /**
   * Runs after acknowledged positions, outside the receiver: confirmations coalesce into at most one
   * run in flight plus one queued. The receiver never waits for it, so work that itself waits for a
   * later replicated commit cannot block the stream that applies that commit.
   * Stopping the sync joins the active confirmation after withdrawing its sequence waiters.
   */
  readonly onConfirmed?: (changedPaths?: readonly string[], signal?: AbortSignal) => void | Promise<void>;
  readonly onConfirmedFailure?: (error: unknown) => void;
  readonly onFailure?: (error: unknown) => void;
  readonly onReplicaHealthChange?: () => void;
  readonly confirmTimeoutMs?: number;
}
type Waiter = { readonly sequence: number; readonly resolve: () => void; readonly reject: (error: unknown) => void };
type ReadyWaiter = { readonly resolve: (ready: boolean) => void; readonly reject: (error: unknown) => void };
const waiters = new Map<string, Set<Waiter>>();
const readyWaiters = new Map<string, Set<ReadyWaiter>>();
/** Running streams by key; `down` holds the last failure until the next connection attempt. */
const streams = new Map<string, { down: unknown; connection: AbortController }>();
const syncKey = (options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">): string =>
  `${options.viewRoot}\u0000${options.repoId}\u0000${options.nodeId}`;

/** Withdrawal also ends the connection holding the withdrawn generation. */
export function failFleetReplicaSync(
  options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">,
  error: Error,
): void {
  const key = syncKey(options),
    stream = streams.get(key);
  if (!stream) return;
  stream.down = error;
  settle(key, null, streamDown(error));
  stream.connection.abort(error);
}
export class FleetReplicaStreamDownError extends Error {
  readonly code = "replica_stream_down";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
class ReplicaConfirmTimeoutError extends Error {
  readonly code = "replica_confirm_timeout";
  constructor(confirmTimeoutMs: number) {
    super(`replica confirmation timed out after ${confirmTimeoutMs}ms`);
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
const settleReady = (key: string, ready: boolean): void => {
  const pending = readyWaiters.get(key);
  if (!pending) return;
  readyWaiters.delete(key);
  for (const waiter of pending) waiter.resolve(ready);
};
/**
 * Write-then-read: resolves once the resident stream applied the center commit sequence of a write.
 * It waits across resident stream reconnects; the caller's signal owns the wait budget.
 */
export function waitForFleetReplicaSequence(
  options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">,
  sequence: number,
  signal?: AbortSignal,
): Promise<void> {
  const current = readReplicaGeneration(`${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`);
  if (signal?.aborted) return Promise.reject(signal.reason);
  const key = syncKey(options),
    stream = streams.get(key);
  if (!stream) return Promise.reject(new FleetReplicaStreamDownError("replica stream is not running"));
  if (current && current.metadata.position.sequence >= sequence) return Promise.resolve();
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
/**
 * Resolves when the resident stream has durably applied its first position and published a generation.
 * A missing stream is an immediate negative result so callers preserve the unavailable-replica contract;
 * an in-flight stream is the only state that waits.
 */
export function waitForFleetReplicaReady(
  options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">,
  signal?: AbortSignal,
): Promise<boolean> {
  const viewDir = `${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`;
  if (readReplicaGeneration(viewDir)) return Promise.resolve(true);
  if (signal?.aborted) return Promise.reject(signal.reason);
  const key = syncKey(options),
    stream = streams.get(key);
  if (!stream || stream.down !== null) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const pending = readyWaiters.get(key) ?? new Set<ReadyWaiter>();
    const waiter: ReadyWaiter = {
      resolve: (ready) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(ready);
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
    readyWaiters.set(key, pending);
  });
}
/** One long-lived stream per node and repository; it reconnects with backoff only after a failure. */
export async function runFleetReplicaSync(options: ReplicaSyncOptions): Promise<void> {
  const key = syncKey(options),
    stream = { down: null as unknown, connection: new AbortController() },
    viewDir = `${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`;
  const observe = (syncFailure: { readonly code: string; readonly message: string } | null): void =>
    recordReplicaHealth(viewDir, {
      syncFailure,
      // Every ACK, keepalive progress included, proves the stream alive; edge doctor ages it.
      ...(syncFailure === null ? { lastHeartbeatAt: new Date().toISOString() } : {}),
    });
  streams.set(key, stream);
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  let failures = 0,
    deterministicFailures = 0,
    lastPosition: string | undefined,
    attemptedConfirmPosition: string | undefined,
    unconfirmedCut = true,
    latchedConfirmFailureKey: string | null = null,
    confirming = false,
    confirmAgain = false,
    confirmation: Promise<void> | undefined,
    activeConfirmController: AbortController | null = null,
    activeConfirmAbort: ((error: unknown) => void) | null = null,
    // null: the mirror must compare the whole cut. A new process cannot know what an earlier one
    // applied without materializing, and a failed or base-backup batch loses its path list.
    pendingChangedPaths: Set<string> | null = null;
  const abortActiveConfirmation = (error: unknown, dropQueued: boolean): void => {
    if (dropQueued) confirmAgain = false;
    activeConfirmController?.abort(error);
    activeConfirmAbort?.(error);
  };
  const confirm = (): void => {
    if (!options.onConfirmed || options.signal?.aborted || options.shutdownSignal?.aborted) return;
    if (confirming) {
      confirmAgain = true;
      return;
    }
    confirming = true;
    confirmation = (async () => {
      try {
        do {
          confirmAgain = false;
          const confirmController = new AbortController(),
            roundController = new AbortController();
          activeConfirmController = confirmController;
          let timer: ReturnType<typeof setTimeout> | undefined,
            onShutdown: (() => void) | undefined,
            onStreamStop: (() => void) | undefined,
            inCallback = false,
            stoppedBetweenRuns = false,
            lastFailure: unknown;
          try {
            // An empty set is a durable eventless ACK; the mirror can advance its marker without rescanning.
            const rawChangedPaths = pendingChangedPaths,
              heartbeatOnly =
                lastPosition !== undefined &&
                lastPosition === attemptedConfirmPosition &&
                rawChangedPaths !== null &&
                rawChangedPaths.size === 0;
            attemptedConfirmPosition = lastPosition;
            pendingChangedPaths = new Set();
            const roundChangedPaths = unconfirmedCut
              ? heartbeatOnly && latchedConfirmFailureKey !== null
                ? []
                : undefined
              : rawChangedPaths
                ? [...rawChangedPaths]
                : undefined;
            const aborted = new Promise<never>((_resolve, reject) => {
              const abortRound = (reason: unknown) => {
                confirmController.abort(reason);
                roundController.abort(reason);
                reject(reason);
              };
              activeConfirmAbort = abortRound;
              onShutdown = () => {
                abortRound(options.shutdownSignal?.reason ?? new Error("daemon closed"));
              };
              if (options.shutdownSignal?.aborted) onShutdown();
              else options.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
              if (Number.isFinite(confirmTimeoutMs)) {
                const timeoutError = new ReplicaConfirmTimeoutError(confirmTimeoutMs);
                timer = setTimeout(() => abortRound(timeoutError), Math.max(1, confirmTimeoutMs));
                timer.unref?.();
              }
            });
            aborted.catch(consumeKnownError);
            onStreamStop = () => {
              if (!inCallback) {
                stoppedBetweenRuns = true;
                roundController.abort(options.signal?.reason ?? new Error("replica stream stopped"));
              }
            };
            options.signal?.addEventListener("abort", onStreamStop, { once: true });
            const run = runDaemonRetry({
              signal: roundController.signal,
              run: async () => {
                inCallback = true;
                try {
                  await options.onConfirmed!(roundChangedPaths, confirmController.signal);
                } finally {
                  inCallback = false;
                }
              },
              retryDelay: (settled, failuresSoFar) => {
                if (settled.ok) return null;
                lastFailure = settled.error;
                const code =
                  typeof settled.error === "object" && settled.error !== null && "code" in settled.error
                    ? String((settled.error as { readonly code?: unknown }).code)
                    : "";
                if (
                  failuresSoFar >= 2 ||
                  options.signal?.aborted ||
                  options.shutdownSignal?.aborted ||
                  confirmController.signal.aborted ||
                  code === "replica_stream_down" ||
                  code === "replica_confirm_timeout" ||
                  deterministicReplicaConfirmFailure(settled.error) !== null
                )
                  return null;
                return replicaRetryDelay(settled.error, failuresSoFar);
              },
            });
            run.catch(consumeKnownError);
            await Promise.race([run, aborted]);
            unconfirmedCut = false;
            latchedConfirmFailureKey = null;
          } catch (error) {
            consumeKnownError(error);
            unconfirmedCut = true;
            const reported = stoppedBetweenRuns && lastFailure !== undefined ? lastFailure : error;
            if (!options.shutdownSignal?.aborted && !(stoppedBetweenRuns && lastFailure === undefined)) {
              const deterministic = deterministicReplicaConfirmFailure(reported);
              if (deterministic === null) {
                latchedConfirmFailureKey = null;
                (
                  options.onConfirmedFailure ?? ((cause) => console.error("[fleet-replica] confirmation failed", cause))
                )(reported);
              } else {
                const failureKey = `${deterministic.code}\u0000${deterministic.message}`;
                if (latchedConfirmFailureKey !== failureKey) {
                  latchedConfirmFailureKey = failureKey;
                  (
                    options.onConfirmedFailure ??
                    ((cause) => console.error("[fleet-replica] confirmation failed", cause))
                  )(reported);
                }
              }
            }
          } finally {
            if (timer) clearTimeout(timer);
            if (onShutdown) options.shutdownSignal?.removeEventListener("abort", onShutdown);
            if (onStreamStop) options.signal?.removeEventListener("abort", onStreamStop);
            if (activeConfirmController === confirmController) {
              activeConfirmController = null;
              activeConfirmAbort = null;
            }
          }
        } while (confirmAgain && !options.signal?.aborted && !options.shutdownSignal?.aborted);
      } finally {
        confirming = false;
      }
    })();
  };
  try {
    while (!options.signal?.aborted) {
      stream.down = null;
      stream.connection = new AbortController();
      const attempt = await runSyncAttempt({
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, stream.connection.signal]) : stream.connection.signal,
        onApplied: async (position, changedPaths) => {
          if (`${position.history}:${position.sequence}` !== lastPosition) {
            failures = 0;
            deterministicFailures = 0;
          }
          lastPosition = `${position.history}:${position.sequence}`;
          if (!changedPaths) pendingChangedPaths = null;
          else if (pendingChangedPaths) for (const changed of changedPaths) pendingChangedPaths.add(changed);
          observe(null);
          options.onReplicaHealthChange?.();
          settle(key, position.sequence);
          settleReady(key, true);
          confirm();
        },
      });
      if (options.signal?.aborted) return;
      const error = attempt.failed ? attempt.error : null;
      // Release any hung confirmation tied to the dropped connection so reconnects can re-confirm.
      abortActiveConfirmation(streamDown(error ?? new Error("replication stream ended")), true);
      const retryDelay = replicaRetryDelay(
        error,
        isDeterministicReplicaFailure(error) ? deterministicFailures++ : failures++,
      );
      if (attempt.failed) {
        if (retryDelay === null && attempt.error instanceof Error)
          attempt.error.message +=
            "; automatic retry budget exhausted after 3 deterministic failures; reconfigure or restart to retry";
        stream.down = attempt.error;
        settleReady(key, false);
        observe(replicaFailure(attempt.error, "replica_sync_failed"));
        options.onReplicaHealthChange?.();
        options.onFailure?.(attempt.error);
      }
      // Preserve the health failure. Reconfiguration or daemon restart grants a new budget.
      if (retryDelay === null) return;
      await new Promise<void>((resolve) => {
        const done = () => {
            options.signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          timer = setTimeout(done, retryDelay),
          onAbort = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    // A restarted stream for the same view already owns the key and its waiters.
    if (streams.get(key) === stream) {
      streams.delete(key);
      settle(key, null, new FleetReplicaStreamDownError("replica stream stopped"));
      settleReady(key, false);
    }
    // Confirmations may themselves await a later replicated sequence. Withdraw those waiters
    // before joining the callback, and keep ownership until its writes/reconcile have finished.
    await confirmation;
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
