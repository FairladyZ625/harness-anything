import { readFileSync } from "node:fs";
import path from "node:path";
import { edgeManifestBlob } from "./fleet/replica-read-model.ts";
import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { sha256Bytes, sha256Text, type CanonicalEventStore } from "@harness-anything/kernel";

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

export function readEdgeRuntimeResult(viewRoot: string, repoId: string, nodeId: string, ref: string): string {
  const match = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref);
  if (!match) {
    const view = locateFleetMirrorView(viewRoot, repoId, nodeId);
    if (view?.entries.has(`.read-model/runtime-results-unavailable/ref-${sha256Text(ref)}`))
      throw Object.assign(new Error(`Historical runtime result ${ref} is unavailable and cannot be downloaded.`), {
        code: "runtime_result_unavailable",
      });
    throw Object.assign(new Error("Invalid runtime result reference."), { code: "replica_unavailable" });
  }
  return decodeRuntimeResult(readEdgeRuntimeResultBytes(viewRoot, repoId, nodeId, match[1]!));
}
export function readEdgeRuntimeResultBytes(
  viewRoot: string,
  repoId: string,
  nodeId: string,
  sha256: string,
): Uint8Array {
  const view = locateFleetMirrorView(viewRoot, repoId, nodeId),
    entry = view?.entries.get(`.read-model/runtime-results/${sha256}`);
  if (view?.entries.has(`.read-model/runtime-results-unavailable/${sha256}`))
    throw Object.assign(
      new Error(
        `Historical runtime result artifact:runtime-result/sha256/${sha256} is unavailable and cannot be downloaded.`,
      ),
      {
        code: "runtime_result_unavailable",
      },
    );
  if (!entry || entry.sha256 !== sha256)
    throw Object.assign(new Error("Runtime result is not present in the current cut."), {
      code: "replica_unavailable",
    });
  return readEdgeViewBlob(viewRoot, view!, sha256);
}

/** Only objects in the already-authorized immutable view may be read; sharing the CAS grants no authority. */
export function readEdgeViewBlob(viewRoot: string, view: FleetMirrorView, sha256: string): Uint8Array {
  const entry = edgeManifestBlob(view.viewDir, view, sha256);
  if (!entry)
    throw Object.assign(new Error("Content is not present in the authorized replica cut."), {
      code: "replica_unavailable",
    });
  const bytes = readFileSync(path.join(viewRoot, "repos", view.repoId, "cas", "sha256", sha256.slice(0, 2), sha256));
  if (bytes.byteLength !== entry.size || sha256Bytes(bytes) !== sha256)
    throw Object.assign(new Error("Content does not match the authorized replica cut."), {
      code: "replica_unavailable",
    });
  return bytes;
}

function decodeRuntimeResult(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error("Runtime result is not UTF-8 text."), { code: "replica_unavailable" });
  }
}
