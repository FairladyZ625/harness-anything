// Test helper: bring one edge replica up to the center's current head, as `ha daemon fleet edge
// sync` does. When an edge daemon host in this process already runs the resident stream for the
// view (startReplicaSyncs), it only waits for that stream; a second stream would fence the first.
// Otherwise it runs the production resident stream (runFleetReplicaSync) for the span of the call.
import path from "node:path";
import type { ReplicationPosition } from "@harness-anything/kernel";
import { readFleetRepositoryMetadataClient } from "../src/fleet/peer.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import {
  runFleetReplicaSync,
  waitForFleetReplicaSequence,
  type ReplicaSyncOptions,
} from "../src/fleet/replica-sync.ts";

export type CatchUpReplicaOptions = Omit<ReplicaSyncOptions, "signal" | "onConfirmed" | "onFailure">;

/**
 * Resolves once the replica applied the center head observed at the call; rejects with the
 * stream's own failure (for example `authorization_denied`) when the stream fails first.
 */
export async function catchUpReplica(
  options: CatchUpReplicaOptions,
): Promise<{ readonly replica: { readonly viewId: string; readonly knownHead: ReplicationPosition } }> {
  const unwrap = (error: unknown): unknown => {
    const cause = (error as { code?: string; cause?: unknown }).cause;
    return (error as { code?: string }).code === "replica_stream_down" && cause !== undefined ? cause : error;
  };
  const head = (await readFleetRepositoryMetadataClient(options)).replicationSequence;
  let owned: { readonly controller: AbortController; readonly running: Promise<void> } | null = null;
  try {
    await waitForFleetReplicaSequence(options, head);
  } catch (error) {
    if (!/not running/u.test(String(error))) throw unwrap(error);
    const controller = new AbortController();
    owned = { controller, running: runFleetReplicaSync({ ...options, signal: controller.signal }) };
    try {
      await waitForFleetReplicaSequence(options, head);
    } catch (failure) {
      throw unwrap(failure);
    }
  } finally {
    owned?.controller.abort();
    await owned?.running;
  }
  const generation = readReplicaGeneration(
    path.join(options.viewRoot, "repos", options.repoId, "views", options.nodeId),
  );
  if (!generation) throw new Error("replica generation is unavailable after catch-up");
  return { replica: { viewId: options.nodeId, knownHead: generation.metadata.position } };
}

export { fleetMirrorCutFile, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
