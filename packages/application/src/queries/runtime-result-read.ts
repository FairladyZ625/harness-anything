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
  return decodeRuntimeResult(bytes);
}

export function runtimeResultSha256(ref: string): string | null {
  return /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref)?.[1] ?? null;
}

function decodeRuntimeResult(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error("Runtime result is not UTF-8 text."), { code: "replica_unavailable" });
  }
}
