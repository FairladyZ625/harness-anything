import { runFleetReplicaPullClient, type FleetReplicaPullClientOptions } from "./peer.ts";
export interface ReplicaSyncOptions extends FleetReplicaPullClientOptions {
  readonly signal?: AbortSignal;
  readonly onConfirmed?: (revision: number) => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void;
}
export async function runFleetReplicaSync(options: ReplicaSyncOptions): Promise<void> {
  if (options.signal?.aborted) return;
  const result = await runFleetReplicaPullClient(options);
  await options.onConfirmed?.(result.current.cut.revision);
}
