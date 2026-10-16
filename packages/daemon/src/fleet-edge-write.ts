import { randomUUID } from "node:crypto";
import { waitForFleetReplicaSequence } from "./fleet/replica-sync.ts";
import { FleetRemoteError as FleetRemoteErrorClass, runFleetUploadClient as fleetUploadClient } from "./fleet/peer.ts";
// The edge write port is the only production composition root for Fleet write
// clients. Keep this list explicit so a new peer export cannot silently bypass
// the port through a wildcard re-export.
export {
  FleetRemoteError,
  awaitFleetRuntimeSessionsClient,
  openFleetEdgeView,
  readFleetRepositoryMetadataClient,
  runFleetRuntimeArchiveClient,
  runFleetRuntimeEventClient,
  runFleetScheduleCommandClient,
  runFleetTaskCommandClient,
  runFleetWriteClient,
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
    ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ERR_TLS"].some((v) => code.includes(v))
  )
    return true;
  return (
    error instanceof Error &&
    /Fleet response timeout|Fleet connection closed|Fleet stream ended mid-frame|session ready expected|task result expected|daemon closed/u.test(
      error.message,
    )
  );
}

function transientEdgeResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    (value as { outcome?: unknown }).outcome === "op_rejected" &&
    ["center_closing", "client_disconnected", "lease_state_unavailable", "op_in_flight"].includes(
      String((value as { code?: unknown }).code ?? ""),
    )
  );
}

export async function runFleetEdgeRetry<T>(options: {
  readonly timeoutMs: number;
  readonly write: () => Promise<T>;
}): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let attempt = 0;
  for (;;) {
    const settled = await options.write().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (settled.ok) {
      if (!transientEdgeResult(settled.value) || Date.now() >= deadline) return settled.value;
    } else {
      if (!retryableEdgeError(settled.error) || Date.now() >= deadline) throw settled.error;
    }
    const remaining = deadline - Date.now();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(fleetEdgeBackoffMs(attempt++), Math.max(1, remaining))),
    );
  }
}

export async function runFleetEdgeUploadClient(
  options: Parameters<typeof fleetUploadClient>[0] & { readonly timeoutMs: number },
): Promise<readonly import("./fleet/command-protocol.ts").FleetDescriptor[]> {
  const operationIds = options.changes.map(() => randomUUID());
  return runFleetEdgeRetry({
    timeoutMs: options.timeoutMs,
    write: () => fleetUploadClient({ ...options, operationIds }),
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
}): Promise<T> {
  const receipt = await runFleetEdgeRetry({ timeoutMs: options.timeoutMs, write: options.write });
  if ("outcome" in receipt && receipt.outcome !== "applied") return receipt;
  if (receipt.replicationSequence === null) return receipt;
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    await waitForFleetReplicaSequence(
      { viewRoot: options.viewRoot, repoId: options.repoId, nodeId: options.nodeId },
      receipt.replicationSequence,
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw new FleetReplicaLagTimeoutError(receipt.replicationSequence, options.timeoutMs, error);
    throw error;
  }
  return receipt;
}
