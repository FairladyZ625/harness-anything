import { waitForFleetReplicaSequence } from "./fleet/replica-sync.ts";
export * from "./fleet/peer.ts";

export interface FleetEdgeWriteReceipt {
  readonly replicationSequence: number | null;
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
  const receipt = await options.write();
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
