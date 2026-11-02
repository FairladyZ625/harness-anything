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

export function startResidentReplicaSync(options: CatchUpReplicaOptions): { readonly close: () => Promise<void> } {
  const controller = new AbortController(),
    running = runFleetReplicaSync({ ...options, signal: controller.signal });
  return {
    close: async () => {
      controller.abort();
      await running;
    },
  };
}

/**
 * Resolves once the replica applied the center head observed at the call; rejects with the
 * stream's own failure (for example `authorization_denied`) when the stream fails first.
 */
export async function catchUpReplica(
  options: CatchUpReplicaOptions,
): Promise<{ readonly replica: { readonly viewId: string; readonly knownHead: ReplicationPosition } }> {
  const viewDir = path.join(options.viewRoot, "repos", options.repoId, "views", options.nodeId),
    reachedHead = (sequence: number): boolean => {
      const generation = readReplicaGeneration(viewDir);
      return generation !== null && generation.metadata.position.sequence >= sequence;
    };
  const unwrap = (error: unknown): unknown => {
    const cause = (error as { code?: string; cause?: unknown }).cause;
    return (error as { code?: string }).code === "replica_stream_down" && cause !== undefined ? cause : error;
  };
  const isIntentionalAbort = (error: unknown): boolean => {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
      name = error instanceof Error ? error.name : undefined;
    return code === "ABORT_ERR" || name === "AbortError";
  };
  const head = (await readFleetRepositoryMetadataClient(options)).replicationSequence;
  let owned: { readonly controller: AbortController; readonly running: Promise<void> } | null = null;
  try {
    await waitForFleetReplicaSequence(options, head);
  } catch (error) {
    const cause = unwrap(error);
    // A resident stream can be replaced while the target cut is already durable. Its
    // transport reports the replacement as ABORT_ERR; the generation is the authoritative
    // completion marker, so accept that close only after confirming the requested sequence.
    if (!/not running/u.test(String(error))) {
      if (!isIntentionalAbort(cause) || !reachedHead(head)) throw cause;
    } else {
      const controller = new AbortController();
      let confirmed!: () => void;
      let failed!: (error: unknown) => void;
      const admitted = new Promise<void>((resolve, reject) => {
        confirmed = resolve;
        failed = reject;
      });
      owned = {
        controller,
        running: runFleetReplicaSync({
          ...options,
          signal: controller.signal,
          onConfirmed: confirmed,
          onFailure: failed,
        }),
      };
      try {
        await admitted;
        await waitForFleetReplicaSequence(options, head);
      } catch (failure) {
        throw unwrap(failure);
      }
    }
  } finally {
    owned?.controller.abort();
    try {
      await owned?.running;
    } catch (error) {
      // The helper owns this short-lived stream and aborts it after the target cut is applied.
      // Node's TLS transport reports that intentional close as ABORT_ERR on newer runtimes;
      // preserve failures from a stream that was not deliberately stopped.
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
        name = error instanceof Error ? error.name : undefined;
      if (!owned?.controller.signal.aborted || (code !== "ABORT_ERR" && name !== "AbortError")) throw error;
    }
  }
  const generation = readReplicaGeneration(viewDir);
  if (!generation) throw new Error("replica generation is unavailable after catch-up");
  return { replica: { viewId: options.nodeId, knownHead: generation.metadata.position } };
}

export { fleetMirrorCutFile, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";

export { readReplicaHealth } from "../src/fleet/replica-health.ts";
