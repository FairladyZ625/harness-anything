import { readFileSync } from "node:fs";
import path from "node:path";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import type { CanonicalEventStore } from "@harness-anything/kernel";

export function readCanonicalRuntimeResult(store: Pick<CanonicalEventStore, "readContentBlob">, ref: string): string {
  const match = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref);
  if (!match)
    throw Object.assign(new Error(`Invalid runtime result reference ${ref}.`), { code: "replica_unavailable" });
  const bytes = store.readContentBlob(match[1]!);
  if (!bytes)
    throw Object.assign(new Error(`Runtime result ${ref} is unavailable at this cut.`), {
      code: "replica_unavailable",
    });
  return new TextDecoder().decode(bytes);
}

export function readEdgeRuntimeResult(viewRoot: string, repoId: string, ref: string): string {
  const match = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref);
  if (!match) throw Object.assign(new Error("Invalid runtime result reference."), { code: "replica_unavailable" });
  return new TextDecoder().decode(readEdgeRuntimeResultBytes(viewRoot, repoId, match[1]!));
}
export function readEdgeRuntimeResultBytes(viewRoot: string, repoId: string, sha256: string): Uint8Array {
  const view = locateFleetMirrorView(viewRoot, repoId),
    entry = view?.entries.get(`.read-model/runtime-results/${sha256}`);
  if (!entry || entry.sha256 !== sha256)
    throw Object.assign(new Error("Runtime result is not present in the current cut."), {
      code: "replica_unavailable",
    });
  return readFileSync(path.join(viewRoot, "repos", repoId, "cas", "sha256", sha256.slice(0, 2), sha256));
}
