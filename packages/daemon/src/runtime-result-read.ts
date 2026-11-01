import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { withReplicaGeneration } from "./fleet/replica-generation.ts";
import { openSqliteEventStore } from "@harness-anything/storage";
import { sha256Bytes, type CanonicalEventStore } from "@harness-anything/kernel";

export function readCanonicalRuntimeResult(store: Pick<CanonicalEventStore, "readContentBlob">, ref: string): string {
  const match = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref);
  if (!match)
    throw Object.assign(new Error(`Invalid runtime result reference ${ref}.`), { code: "replica_unavailable" });
  const bytes = store.readContentBlob(match[1]!);
  if (!bytes)
    throw Object.assign(new Error(`Runtime result ${ref} is unavailable at this cut.`), {
      code: "replica_unavailable",
    });
  return decodeRuntimeResult(bytes);
}

/** The edge mirrors the center's ledger, so it answers exactly as the center does at its applied position. */
export function readEdgeRuntimeResult(viewRoot: string, repoId: string, nodeId: string, ref: string): string {
  const view = locateFleetMirrorView(viewRoot, repoId, nodeId);
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

function decodeRuntimeResult(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error("Runtime result is not UTF-8 text."), { code: "replica_unavailable" });
  }
}
