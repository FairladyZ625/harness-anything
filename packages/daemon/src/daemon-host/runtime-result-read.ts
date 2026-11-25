import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { withReplicaGeneration } from "../fleet-sync/fleet/replica-generation.ts";
import { openSqliteEventStore } from "@harness-anything/storage";
import { sha256Bytes } from "@harness-anything/kernel";
import { readCanonicalRuntimeResult } from "@harness-anything/application/internal/queries/runtime-result-read.ts";

export { readCanonicalRuntimeResult };

/** The edge mirrors the center's ledger, so it answers exactly as the center does at its applied position. */
export function readEdgeRuntimeResult(viewRoot: string, repoId: string, nodeId: string, ref: string): string {
  const view = locateFleetMirrorView(viewRoot, repoId, nodeId, { includeEntries: false });
  if (!view) throw Object.assign(new Error("Replica generation is unavailable."), { code: "replica_unavailable" });
  return readCanonicalRuntimeResult({ readContentBlob: (sha256) => edgeObject(view, sha256) }, ref);
}

/** A content object of the edge's replica ledger; the replica holds every object the center holds. */
export function readEdgeViewBlob(view: FleetMirrorView, sha256: string): Uint8Array {
  const bytes = edgeObject(view, sha256);
  if (!bytes)
    throw Object.assign(new Error("Content is not present in the replica."), {
      code: "replica_unavailable",
    });
  return bytes;
}

/** Read one bounded slice; the caller verifies the complete content identity across slices. */
export function readEdgeViewBlobRange(
  view: FleetMirrorView,
  sha256: string,
  offset: number,
  length: number,
): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return null;
  return withReplicaGeneration(view.viewDir, (generation) => {
    if (!generation)
      throw Object.assign(new Error("Replica generation is unavailable."), { code: "replica_unavailable" });
    const store = openSqliteEventStore({
      databasePath: generation.ledgerPath,
      repoId: generation.metadata.repoId,
      generation: generation.metadata.ledgerGeneration,
      readOnly: true,
    });
    try {
      return store.readContentObjectRange(sha256, offset, length);
    } finally {
      store.close();
    }
  });
}

function edgeObject(view: FleetMirrorView, sha256: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return null;
  return withReplicaGeneration(view.viewDir, (generation) => {
    if (!generation)
      throw Object.assign(new Error("Replica generation is unavailable."), { code: "replica_unavailable" });
    const store = openSqliteEventStore({
      databasePath: generation.ledgerPath,
      repoId: generation.metadata.repoId,
      generation: generation.metadata.ledgerGeneration,
      readOnly: true,
    });
    try {
      const bytes = store.readContentObject(sha256);
      if (bytes && sha256Bytes(bytes) !== sha256)
        throw Object.assign(new Error("Content does not match its replica object digest."), {
          code: "replica_unavailable",
        });
      return bytes;
    } finally {
      store.close();
    }
  });
}
