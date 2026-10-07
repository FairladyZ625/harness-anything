// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";

const cut = (revision: number, byte: string) => ({ revision, headDigest: `sha256:${byte.repeat(64)}` });

test("durable ACK store isolates view keys and commits exact proof with its L1-era registration floor", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-ack-")),
    key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" },
    other = { ...key, viewId: "view-b" },
    toCut = cut(8, "a"),
    digest = "b".repeat(64);
  try {
    let store = openReplicaAckStore(root);
    assert.equal(store.register(key, 5), 5);
    assert.equal(store.register(key, 9), 5);
    assert.equal(store.register(other, 7), 7);
    const lease = store.delivery.claim(key, "holder-a", Date.parse("2026-08-14T00:00:00.000Z"), 30_000)!;
    const offer = store.offer(key, {
      transferId: "transfer-a",
      fromCut: null,
      toCut,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: "2026-08-14T00:00:00.000Z",
    });
    assert.deepEqual(store.offer(key, { ...offer, transferId: "replacement-denied" }), offer);
    assert.equal(
      store.ack(key, "transfer-a", toCut, "c".repeat(64), "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z", lease)
        .outcome,
      "op_rejected",
    );
    assert.equal(
      store.ack(
        { ...key, nodeId: "node-b" },
        "transfer-a",
        toCut,
        digest,
        "2026-08-14T00:00:01.000Z",
        "2026-08-13T00:00:00.000Z",
        lease,
      ).outcome,
      "op_rejected",
    );
    assert.equal(
      store.ack(key, "transfer-a", toCut, digest, "2026-08-14T00:00:01.000Z", "2026-08-13T00:00:00.000Z", lease)
        .outcome,
      "applied",
    );
    assert.equal(store.proof(key, 8)?.manifestDigest, digest);
    assert.equal(store.cursor(key)?.revision, 8);
    assert.equal(store.offerFor(key), null);
    store.close();
    store = openReplicaAckStore(root);
    assert.equal(store.registrationRevision(key), 5);
    assert.equal(store.registrationRevision(other), 7);
    assert.equal(store.proof(key, 8)?.transferId, "transfer-a");
    assert.equal(
      store.ack(key, "transfer-a", toCut, digest, "2026-08-14T00:00:02.000Z", "2026-08-13T00:00:00.000Z", lease)
        .outcome,
      "current",
    );
    assert.equal(store.proof(other, 8), null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-revision re-delivery under a new transfer converges to current without touching the recorded proof", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-ack-retransfer-")),
    key = { nodeId: "node-a", viewId: "view-a", repoId: "repo-a" },
    toCut = cut(8, "a"),
    digest = "b".repeat(64);
  try {
    const store = openReplicaAckStore(root);
    store.register(key, 5);
    const lease = store.delivery.claim(key, "holder-a", Date.parse("2026-10-08T00:00:00.000Z"), 30_000)!;
    store.offer(key, {
      transferId: "transfer-delta",
      fromCut: cut(5, "f"),
      toCut,
      manifestDigest: digest,
      kind: "delta",
      issuedAt: "2026-10-08T00:00:00.000Z",
    });
    assert.equal(
      store.ack(key, "transfer-delta", toCut, digest, "2026-10-08T00:00:01.000Z", "2026-10-07T00:00:00.000Z", lease)
        .outcome,
      "applied",
    );
    // The delta base slid out of retention, so the center re-offers the same revision
    // as a fresh snapshot under a new transfer id; its ACK must converge, not collide.
    store.offer(key, {
      transferId: "transfer-snapshot",
      fromCut: null,
      toCut,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: "2026-10-08T00:00:02.000Z",
    });
    const converged = store.ack(
      key,
      "transfer-snapshot",
      toCut,
      digest,
      "2026-10-08T00:00:03.000Z",
      "2026-10-07T00:00:00.000Z",
      lease,
    );
    assert.equal(converged.outcome, "current");
    assert.equal(converged.cursor?.revision, 8);
    assert.equal(store.proof(key, 8)?.transferId, "transfer-delta");
    assert.equal(store.offerFor(key), null);
    // A re-offered cut that disagrees with the recorded proof at the same revision is rejected, not merged.
    const divergentCut = cut(8, "c"),
      divergentDigest = "d".repeat(64);
    store.offer(key, {
      transferId: "transfer-divergent",
      fromCut: null,
      toCut: divergentCut,
      manifestDigest: divergentDigest,
      kind: "snapshot",
      issuedAt: "2026-10-08T00:00:04.000Z",
    });
    assert.equal(
      store.ack(
        key,
        "transfer-divergent",
        divergentCut,
        divergentDigest,
        "2026-10-08T00:00:05.000Z",
        "2026-10-07T00:00:00.000Z",
        lease,
      ).outcome,
      "op_rejected",
    );
    assert.equal(store.proof(key, 8)?.transferId, "transfer-delta");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery leases fence expiry across workers and isolate node/repo/view metrics", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-delivery-lease-"));
  const key = { nodeId: "node-a", repoId: "repo-a", viewId: "view-a" };
  const first = openReplicaAckStore(root),
    second = openReplicaAckStore(root);
  try {
    const lease = first.delivery.claim(key, "worker-one", 1000, 100)!;
    assert.equal(lease.claimFence, 1);
    assert.equal(second.delivery.claim(key, "worker-two", 1050, 100), null);
    assert.equal(second.delivery.claim({ ...key, viewId: "view-other" }, "worker-two", 1050, 100), null);
    assert.ok(second.delivery.claim({ ...key, nodeId: "node-b" }, "worker-two", 1050, 100));
    assert.ok(second.delivery.claim({ ...key, repoId: "repo-b" }, "worker-two", 1050, 100));
    const replacement = second.delivery.claim(key, "worker-two", 1100, 100)!;
    assert.equal(replacement.claimFence, 2);
    assert.equal(first.delivery.renew(lease, 1101, 100), false);
    first.delivery.release(lease);
    assert.equal(second.delivery.active(key, 1101)?.holderId, "worker-two");
    const target = cut(8, "a"),
      digest = "b".repeat(64);
    first.offer(key, {
      transferId: "fenced",
      fromCut: null,
      toCut: target,
      manifestDigest: digest,
      kind: "snapshot",
      issuedAt: new Date(1100).toISOString(),
    });
    assert.equal(
      first.ack(key, "fenced", target, digest, new Date(1101).toISOString(), new Date(900).toISOString(), lease)
        .outcome,
      "op_rejected",
    );
    assert.equal(first.cursor(key), null);
    assert.equal(
      second.ack(key, "fenced", target, digest, new Date(1102).toISOString(), new Date(900).toISOString(), replacement)
        .outcome,
      "applied",
    );
    second.delivery.record(key, { bytes: 17, started: "delta" });
    second.delivery.record(key, { failureCode: "cut_missing" });
    assert.deepEqual(first.delivery.metrics(key), {
      transferBytes: 17,
      snapshotStarts: 0,
      deltaStarts: 1,
      errors: 1,
      lastFailureCode: "cut_missing",
    });
    assert.equal(first.delivery.metrics({ ...key, nodeId: "node-b" }).transferBytes, 0);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
