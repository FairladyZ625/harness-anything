// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";

const cut = (revision: number, byte: string) => ({ revision, headDigest: `sha256:${byte.repeat(64)}` });

test("durable ACK store isolates view keys and commits exact proof with its L1-era registration floor", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-ack-")), key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" }, other = { ...key, viewId: "view-b" }, toCut = cut(8, "a"), digest = "b".repeat(64);
  try {
    let store = openReplicaAckStore(root);
    assert.equal(store.register(key, 5), 5); assert.equal(store.register(key, 9), 5); assert.equal(store.register(other, 7), 7);
    const offer = store.offer(key, { transferId: "transfer-a", fromCut: null, toCut, manifestDigest: digest, kind: "snapshot", issuedAt: "2026-08-14T00:00:00.000Z" });
    assert.deepEqual(store.offer(key, { ...offer, transferId: "replacement-denied" }), offer);
    assert.equal(store.ack(key, "transfer-a", toCut, "c".repeat(64), "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z").outcome, "op_rejected");
    assert.equal(store.ack({ ...key, nodeId: "node-b" }, "transfer-a", toCut, digest, "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z").outcome, "op_rejected");
    assert.equal(store.ack(key, "transfer-a", toCut, digest, "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z").outcome, "applied");
    assert.equal(store.proof(key, 8)?.manifestDigest, digest); assert.equal(store.cursor(key)?.revision, 8); assert.equal(store.offerFor(key), null);
    store.close(); store = openReplicaAckStore(root);
    assert.equal(store.registrationRevision(key), 5); assert.equal(store.registrationRevision(other), 7); assert.equal(store.proof(key, 8)?.transferId, "transfer-a");
    assert.equal(store.ack(key, "transfer-a", toCut, digest, "2026-08-14T00:00:02.000Z", "2026-08-13T00:00:00.000Z").outcome, "current");
    assert.equal(store.proof(other, 8), null); store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
