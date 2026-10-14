import { runFleetReplicaPullClient, type FleetReplicaPullClientOptions } from "./peer.ts";
export interface ReplicaSyncOptions extends FleetReplicaPullClientOptions {
  readonly signal?: AbortSignal;
  readonly onConfirmed?: (revision: number) => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void;
}
export async function runFleetReplicaSync(options: ReplicaSyncOptions): Promise<void> {
  while (!options.signal?.aborted) {
    try {
      const result = await runFleetReplicaPullClient(options);
      await options.onConfirmed?.(result.current.cut.revision);
      return;
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onFailure?.(error);
      throw error;
    }
  }
}
