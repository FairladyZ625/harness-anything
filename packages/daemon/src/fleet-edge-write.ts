import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { waitForFleetReplicaSequence } from "./fleet/replica-sync.ts";
import {
  FleetRemoteError as FleetRemoteErrorClass,
  runFleetRuntimeArchiveClient as peerRunFleetRuntimeArchiveClient,
  runFleetRuntimeEventClient as peerRunFleetRuntimeEventClient,
  runFleetScheduleCommandClient as peerRunFleetScheduleCommandClient,
  runFleetTaskCommandClient as peerRunFleetTaskCommandClient,
  runFleetUploadClient as peerRunFleetUploadClient,
  runFleetWriteClient as peerRunFleetWriteClient,
} from "./fleet/peer.ts";
// The edge write port is the only production composition root for Fleet write
// clients. Keep this list explicit so a new peer export cannot silently bypass
// the port through a wildcard re-export.
export {
  FleetRemoteError,
  readFleetOperationalClient,
  openFleetEdgeView,
  readFleetRepositoryMetadataClient,
} from "./fleet/peer.ts";
export type {
  FleetEdgeView,
  FleetPeerOptions,
  FleetTaskCommandClientOptions,
  FleetWriteClientOptions,
  FleetWriteClientResult,
} from "./fleet/peer.ts";

export interface FleetEdgeWriteReceipt {
  readonly replicationSequence: number | null;
}

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 30_000;

export function fleetEdgeBackoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling) + 1;
}

function retryableEdgeError(error: unknown): boolean {
  if (error instanceof FleetRemoteErrorClass) return error.retryable;
  const code =
    typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
  if (
    typeof code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "ERR_TLS",
      // A center write can be durable while the resident edge stream is between
      // reconnects. The command opId is idempotent, so retry the read-after-write
      // confirmation until the stream can prove the same cut.
      "replica_stream_down",
      "replica_lag_timeout",
    ].some((v) => code.includes(v))
  )
    return true;
  return (
    error instanceof Error &&
    /Fleet response timeout|Fleet connection closed|Fleet stream ended mid-frame|session ready expected|task result expected|daemon closed/u.test(
      error.message,
    )
  );
}

/** A rejected receipt the center can still accept on retry; any other rejection is its decision. */
export function transientFleetReceipt(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    (value as { outcome?: unknown }).outcome === "op_rejected" &&
    ["center_closing", "client_disconnected", "lease_state_unavailable", "op_in_flight", "repo_unavailable"].includes(
      String((value as { code?: unknown }).code ?? ""),
    )
  );
}

export async function runFleetEdgeRetry<T>(options: {
  readonly timeoutMs: number;
  readonly write: () => Promise<T>;
  /** Daemon-close lifetime. Aborting stops both the in-flight attempt and the backoff sleep. */
  readonly signal?: AbortSignal;
}): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const settled = await raceLifetime(options.write(), options.signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (settled.ok) {
      if (!transientFleetReceipt(settled.value) || Date.now() >= deadline) return settled.value;
    } else {
      if (!retryableEdgeError(settled.error) || Date.now() >= deadline) throw settled.error;
    }
    const remaining = deadline - Date.now();
    try {
      await delay(Math.min(fleetEdgeBackoffMs(attempt++), Math.max(1, remaining)), undefined, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // node:timers/promises wraps the signal reason in an AbortError; close owns the reason.
      if (options.signal?.aborted) throw abortReason(options.signal);
      throw error;
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Reject with the lifetime signal's own reason as soon as it aborts. An operation that ignores
 * the signal still cannot keep its caller alive past the lifetime; one that honors it also
 * settles through its own rejection.
 */
export function raceLifetime<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const pending = operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function runFleetEdgeUploadClient(
  options: Parameters<typeof peerRunFleetUploadClient>[0] & { readonly timeoutMs: number },
): Promise<readonly import("./fleet/command-protocol.ts").FleetDescriptor[]> {
  const operationIds = options.changes.map(() => randomUUID());
  return runFleetEdgeRetry({
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    write: () => peerRunFleetUploadClient({ ...options, operationIds }),
  });
}

// Peer clients are composed here so production callers cannot import the wire
// implementation from `fleet/peer.ts` through a re-export.
export const runFleetWriteClient = peerRunFleetWriteClient;
export const runFleetRuntimeEventClient = peerRunFleetRuntimeEventClient;
export const runFleetScheduleCommandClient = peerRunFleetScheduleCommandClient;
export const runFleetTaskCommandClient = peerRunFleetTaskCommandClient;

export async function runFleetEdgeRuntimeArchiveClient(
  options: Parameters<typeof peerRunFleetRuntimeArchiveClient>[0],
): Promise<Awaited<ReturnType<typeof peerRunFleetRuntimeArchiveClient>>> {
  // One attempt: a failed archive is recovered by runtime reconcile after the center returns,
  // so retrying here would only delay the failure that triggers that recovery.
  return peerRunFleetRuntimeArchiveClient({ ...options, opId: randomUUID() });
}

export async function runFleetEdgeTaskCommand<T>(options: {
  readonly timeoutMs: number;
  readonly readOnly: boolean;
  readonly write: () => Promise<T>;
  readonly settle?: () => Promise<T>;
  readonly signal?: AbortSignal;
}): Promise<T> {
  // A write retries as a whole (center write plus replica catch-up), matching one canonical attempt per opId.
  return runFleetEdgeRetry({
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    write: !options.readOnly && options.settle ? options.settle : options.write,
  });
}

export class FleetReplicaLagTimeoutError extends Error {
  readonly code = "replica_lag_timeout";

  constructor(sequence: number, timeoutMs: number, cause?: unknown) {
    super(
      `Edge replica did not apply sequence ${sequence} within ${timeoutMs}ms.`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export async function runFleetEdgeWrite<T extends FleetEdgeWriteReceipt>(options: {
  readonly viewRoot: string;
  readonly repoId: string;
  readonly nodeId: string;
  readonly timeoutMs: number;
  readonly write: () => Promise<T>;
  readonly signal?: AbortSignal;
}): Promise<T> {
  const receipt = await options.write();
  if ("outcome" in receipt && receipt.outcome !== "applied") return receipt;
  if (receipt.replicationSequence === null) return receipt;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs),
    signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  try {
    await waitForFleetReplicaSequence(
      { viewRoot: options.viewRoot, repoId: options.repoId, nodeId: options.nodeId },
      receipt.replicationSequence,
      signal,
    );
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (timeoutSignal.aborted)
      throw new FleetReplicaLagTimeoutError(receipt.replicationSequence, options.timeoutMs, error);
    throw error;
  }
  return receipt;
}
