import type { RepoReadPayload, RepoWriterRequestV1 } from "../../src/repo-writer-protocol.ts";
export function holdRead(barrier: Int32Array): void {
  const sequence = Atomics.load(barrier, 0);
  if (sequence === 0) return;
  Atomics.store(barrier, 1, sequence);
  Atomics.notify(barrier, 1);
  // A deliberately slow synchronous read. The external probes release it early when the
  // entry thread can serve them; the negative control occupies that entry thread for 1s.
  Atomics.wait(barrier, 2, sequence - 1, 1_000);
}
export function gateRequest(barrier: Int32Array, request: RepoWriterRequestV1): void {
  const payload = request.payload as RepoReadPayload;
  if (payload.method === "read") holdRead(barrier);
}
