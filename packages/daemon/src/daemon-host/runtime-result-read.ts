import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { withReplicaGeneration } from "../fleet-sync/fleet/replica-generation.ts";
import { openSqliteEventStore } from "@harness-anything/storage";
import { sha256Bytes } from "@harness-anything/kernel";
import { readCanonicalRuntimeResult } from "@harness-anything/application/internal/queries/runtime-result-read.ts";
import {
  BlobDigestMismatchError,
  BlobNotFetchedOfflineError,
  EdgeBlobError,
  readEdgeViewBlobLazy,
} from "./fleet/blob-fetch.ts";

export { readCanonicalRuntimeResult, readEdgeViewBlobLazy, BlobNotFetchedOfflineError };

/** The edge mirrors the center's ledger, so it answers exactly as the center does at its applied position. */
export function readEdgeRuntimeResult(viewRoot: string, repoId: string, nodeId: string, ref: string): string {
  const view = locateFleetMirrorView(viewRoot, repoId, nodeId, { includeEntries: false });
  if (!view) throw Object.assign(new Error("Replica generation is unavailable."), { code: "replica_unavailable" });
  return readCanonicalRuntimeResult({ readContentBlob: (sha256) => edgeObject(view, sha256) }, ref);
}

/**
 * Reads a content object from the edge's local replica ledger.
 * Strict L3 fail-closed: on `fleet-basebackup/v4` replicas where cold blobs are deferred until
 * fetched, an un-fetched blob throws explicit `blob_not_fetched_offline` instead of returning empty
 * bytes or silently degrading.
 */
export function readEdgeViewBlob(view: FleetMirrorView, sha256: string): Uint8Array {
  const result = edgeObjectWithSchema(view, sha256);
  if (result.bytes !== null) return result.bytes;
  if (result.schema === "fleet-basebackup/v4") {
    throw new BlobNotFetchedOfflineError(sha256);
  }
  throw Object.assign(new Error("Content is not present in the replica."), {
    code: "replica_unavailable",
  });
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
      const range = store.readContentObjectRange(sha256, offset, length);
      if (range === null && generation.metadata.schema === "fleet-basebackup/v4") {
        throw new BlobNotFetchedOfflineError(sha256);
      }
      return range;
    } finally {
      store.close();
    }
  });
}

function edgeObject(view: FleetMirrorView, sha256: string): Uint8Array | null {
  const result = edgeObjectWithSchema(view, sha256);
  if (result.bytes === null && result.schema === "fleet-basebackup/v4") {
    throw new BlobNotFetchedOfflineError(sha256);
  }
  return result.bytes;
}

function edgeObjectWithSchema(
  view: FleetMirrorView,
  sha256: string,
): { readonly bytes: Uint8Array | null; readonly schema: string | null } {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return { bytes: null, schema: null };
  return withReplicaGeneration(view.viewDir, (generation) => {
    if (!generation) throw new EdgeBlobError("replica_unavailable", "Replica generation is unavailable.");
    const store = openSqliteEventStore({
      databasePath: generation.ledgerPath,
      repoId: generation.metadata.repoId,
      generation: generation.metadata.ledgerGeneration,
      readOnly: true,
    });
    try {
      const bytes = store.readContentObject(sha256);
      if (bytes && sha256Bytes(bytes) !== sha256)
        throw new BlobDigestMismatchError(sha256, "Content does not match its replica object digest.");
      return { bytes, schema: generation.metadata.schema };
    } finally {
      store.close();
    }
  });
}
