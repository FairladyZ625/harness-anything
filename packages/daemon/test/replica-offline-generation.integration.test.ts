// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openReplicaCutSource, invalidateReplicaCutsOffline } from "../src/fleet/replica-cut-store.ts";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";
import { makeOffer } from "../src/fleet/center-replica-offer.ts";
import { wireCut } from "../src/fleet/center-transport.ts";

test("offline generation invalidation forces two registered edges to snapshot at an unchanged revision and head", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-offline-replica-"));
  const repoId = "generation-test",
    revision = {
      revision: 8,
      headDigest: `sha256:${"a".repeat(64)}`,
      occurredAt: "2026-10-10T00:00:00.000Z",
    };
  const keys = ["edge-a", "edge-b"].map((nodeId) => ({ repoId, nodeId, viewId: "view" }));
  const open = (generation: number) =>
    openReplicaCutSource({
      repoId,
      localRoot: root,
      readRevision: () => revision,
      readContentBlob: () => null,
      readSequence: (_from, read) =>
        read({
          from: null,
          to: revision,
          changes: [{ op: "put", path: "read-model/task.json", blob: null, text: JSON.stringify({ generation }) }],
        }),
    });
  try {
    const authorization = path.join(root, "authorization.json");
    writeFileSync(authorization, '{"owner":"retained"}');
    const before = open(2),
      ack = openReplicaAckStore(root),
      old = before.activate()!;
    const now = Date.parse(revision.occurredAt);
    const leases = keys.map((key) => {
      ack.register(key, 5);
      const lease = ack.delivery.claim(key, "holder", now, 30_000)!;
      ack.offer(key, {
        transferId: key.nodeId,
        fromCut: null,
        toCut: wireCut(old),
        manifestDigest: old.manifest.digest,
        kind: "snapshot",
        issuedAt: revision.occurredAt,
      });
      assert.equal(
        ack.ack(key, key.nodeId, wireCut(old), old.manifest.digest, revision.occurredAt, revision.occurredAt, lease)
          .outcome,
        "applied",
      );
      ack.offer(key, {
        transferId: `${key.nodeId}-pending`,
        fromCut: null,
        toCut: wireCut(old),
        manifestDigest: old.manifest.digest,
        kind: "snapshot",
        issuedAt: revision.occurredAt,
      });
      return lease;
    });
    before.close();
    ack.close();
    // The operator has stopped center and cut workers before entering the offline window.
    invalidateReplicaCutsOffline(root, repoId);
    const invalidator = openReplicaAckStore(root);
    try {
      invalidator.invalidateOffline(repoId);
    } finally {
      invalidator.close();
    }
    const after = open(3),
      reopened = openReplicaAckStore(root);
    try {
      const current = after.activate()!;
      assert.equal(current.revision, old.revision);
      assert.equal(current.headDigest, old.headDigest);
      const entry = after.manifestEntry(8, "read-model/task.json")!;
      assert.equal(Buffer.from(after.content(entry.blob)).toString(), '{"generation":3}');
      assert.notEqual(current.manifest.digest, old.manifest.digest);
      assert.equal(after.changes(7, 8), null);
      assert.equal(readFileSync(authorization, "utf8"), '{"owner":"retained"}');
      for (const [index, key] of keys.entries()) {
        assert.equal(reopened.registrationRevision(key), 5);
        assert.equal(reopened.proof(key, 8), null);
        assert.equal(reopened.cursor(key), null);
        assert.equal(reopened.offerFor(key), null);
        assert.equal(reopened.delivery.active(key, now), null);
        assert.equal(reopened.delivery.renew(leases[index]!, now, 30_000).renewed, false);
        const nextLease = reopened.delivery.claim(key, "holder", now, 30_000)!;
        assert.ok(nextLease.claimFence > leases[index]!.claimFence);
        assert.equal(reopened.delivery.renew(leases[index]!, now, 30_000).renewed, false);
        assert.equal(
          reopened.ack(
            key,
            key.nodeId,
            wireCut(old),
            old.manifest.digest,
            revision.occurredAt,
            revision.occurredAt,
            leases[index]!,
          ).outcome,
          "op_rejected",
        );
        const offer = await makeOffer(key, reopened.cursor(key), current, after, revision.occurredAt);
        assert.equal(offer.kind, "snapshot");
        assert.equal(offer.fromCut, null);
        reopened.offer(key, offer);
        assert.equal(
          reopened.ack(
            key,
            offer.transferId,
            offer.toCut,
            offer.manifestDigest,
            revision.occurredAt,
            revision.occurredAt,
            nextLease,
          ).outcome,
          "applied",
        );
      }
      console.log(
        "OFFLINE_REPLICA_EVIDENCE=" +
          JSON.stringify({
            revision: 8,
            sameHead: true,
            registrations: reopened.keys(),
            firstSync: "snapshot",
            oldLeases: "rejected",
          }),
      );
    } finally {
      after.close();
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
