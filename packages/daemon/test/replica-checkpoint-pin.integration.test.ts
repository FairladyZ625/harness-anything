// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { READ_MODEL_SCHEMA_GENERATION, sha256Bytes, type EdgeReadModelRows } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";

const rows: EdgeReadModelRows = {
  tasks: [],
  taskGeneration: [],
  taskProgress: [],
  entities: [],
  leases: [],
  relations: [],
  decisions: [],
  facts: [],
  presetSnapshots: [],
  repository: [],
};
for (const termination of ["ack", "disconnect", "expire", "quota"] as const) {
  test(`lease pins protect checkpoint dependencies across 64 publications and end on ${termination}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-checkpoint-pin-"));
    const first = lifecycleFixture().events[0]!;
    let revision = 1,
      builds = 0;
    const event = (r: number) => ({ ...first, workspaceRevision: r, opId: `op-${r}`, eventId: `event-${r}` });
    const source = openReplicaCutSource({
      repoId: "checkpoint",
      localRoot: root,
      readBasis: (after) => ({
        watermark: revision,
        sourceRevision: revision,
        headEvent: event(revision),
        documents: [],
        events: after === null ? [] : Array.from({ length: revision - after }, (_, i) => event(after + i + 1)),
      }),
      readContentBlob: () => null,
      readEdgeReadModel: (read) => {
        builds++;
        return read({ sourceRevision: revision, rootThreshold: 0, rows });
      },
    });
    const ackStore = openReplicaAckStore(path.join(root, "center"));
    const key = { nodeId: "node-a", viewId: "node-a", repoId: "checkpoint" };
    const secondKey = { ...key, nodeId: "node-b", viewId: "node-b" };
    try {
      source.activate();
      const lease = ackStore.delivery.claim(key, "session-a", Date.now(), 30_000)!;
      const second = ackStore.delivery.claim(secondKey, "session-b", Date.now(), 30_000)!;
      assert.equal(ackStore.delivery.claim(key, "other-session", Date.now(), 30_000), null);
      const { cut: target } = await source.pin(
        lease,
        lease.holderId,
        null,
        termination === "quota" ? 1000 : 1_000_000,
        path.join(root, "center"),
      );
      const { cut: other } = await source.pin(second, second.holderId, null, 1_000_000, path.join(root, "center"));
      assert.deepEqual(target, other);
      assert.equal(builds, 1, "two edges share one build");
      const offer = ackStore.offer(key, await makeOffer(key, null, target, source, new Date().toISOString()));
      const frames = offerFrames(offer, source, { owner: "person", digest: "a".repeat(64) });
      assert.equal((await frames.next()).value?.schema, "fleet.snapshot.begin/v1");
      for (revision = 2; revision <= 66; revision++) await source.waitForCut(revision);
      assert.ok(source.cut(1), "other edge still owns its pin");
      {
        assert.equal(
          ackStore.delivery.renew(lease, Date.now(), 30_000),
          true,
          "lease remains renewable after publications",
        );
        t.diagnostic(`termination=${termination}: renewal=true pinActive=${source.pinActive(lease)}`);
        assert.equal(source.pinActive(lease), true);
        let bytes = 0;
        for await (const frame of frames)
          if (frame.schema === "fleet.snapshot.chunk/v1") bytes += Buffer.from(frame.dataBase64, "base64").length;
        assert.ok(bytes > 0);
        t.diagnostic(`snapshot begin -> 65 publications -> ${bytes} bytes -> ${termination}`);
        if (termination === "ack" || termination === "quota") {
          assert.equal(
            ackStore.ack(
              key,
              offer.transferId,
              offer.toCut,
              offer.manifestDigest,
              new Date().toISOString(),
              source.eventAt(1)!,
              lease,
            ).outcome,
            "applied",
          );
          ackStore.delivery.release(lease);
        } else if (termination === "expire") {
          // Advance the authoritative clock only after real delivery; no TTL renewal can resurrect it.
          const expiredAt = ackStore.delivery.active(lease, Date.now())!.expiresAt + 1;
          t.mock.method(Date, "now", () => expiredAt);
          assert.equal(
            ackStore.ack(
              key,
              offer.transferId,
              offer.toCut,
              offer.manifestDigest,
              new Date(expiredAt).toISOString(),
              source.eventAt(1)!,
              lease,
            ).outcome,
            "op_rejected",
          );
        } else ackStore.delivery.release(lease);
      }
      ackStore.delivery.release(second);
      revision = 67;
      await source.waitForCut(67);
      if (termination === "ack") {
        assert.equal(source.pinActive(lease), true, "confirmed cursor has a new bounded delta window");
        assert.ok(source.changes(1, 67));
        for (revision = 68; revision <= 131; revision++) await source.waitForCut(revision);
      }
      assert.equal(source.pinActive(lease), false);
      assert.equal(source.cut(1), null);
      assert.equal(source.changes(1, 67), null);
      assert.equal(offer.toCut.schemaGeneration, READ_MODEL_SCHEMA_GENERATION);
    } finally {
      source.close();
      ackStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("three edges share retained blobs; quota rejects the newcomer without fencing existing pins", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-checkpoint-shared-quota-"));
  const leaseRoot = path.join(root, "center");
  const body = Buffer.alloc(1024, "x"),
    digest = sha256Bytes(body);
  const first = lifecycleFixture().events[0]!;
  let revision = 1;
  const event = (r: number) => ({ ...first, workspaceRevision: r, opId: `op-${r}`, eventId: `event-${r}` });
  const source = openReplicaCutSource({
    repoId: "checkpoint",
    localRoot: root,
    readBasis: (after) => ({
      watermark: revision,
      sourceRevision: revision,
      headEvent: event(revision),
      documents: ["context/a.md", "context/b.md"].map((path) => ({
        path,
        blobSha256: digest,
        size: body.length,
        mediaType: "text/markdown",
      })),
      events: after === null ? [] : Array.from({ length: revision - after }, (_, i) => event(after + i + 1)),
    }),
    readContentBlob: (sha) => (sha === digest ? body : null),
    readEdgeReadModel: (read) => read({ sourceRevision: revision, rootThreshold: 0, rows }),
  });
  const ackStore = openReplicaAckStore(leaseRoot);
  try {
    source.activate();
    const metadataBytes = source
      .manifest(1)!
      .filter((entry) => entry.path.startsWith(".read-model/"))
      .reduce((sum, entry) => sum + entry.blob.size, 0);
    const quota = body.length + 3 * metadataBytes;
    const leases = ["a", "b", "c", "d"].map(
      (nodeId) =>
        ackStore.delivery.claim({ nodeId, viewId: nodeId, repoId: "checkpoint" }, nodeId, Date.now(), 30_000)!,
    );
    for (let i = 0; i < 3; i++) {
      revision = i + 1;
      await source.waitForCut(revision);
      const { cut: target } = await source.pin(leases[i]!, leases[i]!.holderId, null, quota, leaseRoot);
      assert.equal(target.revision, revision);
      assert.ok(target.manifest.totalBytes > quota, "duplicate document paths do not consume duplicate blob storage");
    }
    revision = 4;
    await source.waitForCut(revision);
    await assert.rejects(source.pin(leases[3]!, leases[3]!.holderId, null, quota, leaseRoot), {
      code: "replica_quota_insufficient",
    });
    assert.equal(source.pinActive(leases[3]!), false);
    for (const lease of leases.slice(0, 3)) {
      assert.equal(source.pinActive(lease), true);
      assert.equal(ackStore.delivery.renew(lease, Date.now(), 30_000), true);
    }
    const unique = new Map(
      [1, 2, 3, 4].flatMap((r) => source.manifest(r)!.map((entry) => [entry.blob.sha256, entry.blob.size] as const)),
    );
    t.diagnostic(
      `three different checkpoints admitted; quota=${quota}; fourth shared union=${[...unique.values()].reduce((a, b) => a + b, 0)}; first three pins/renewals remain active`,
    );
    source.releasePin(leases[0]!);
    ackStore.delivery.release(leases[0]!);
    assert.equal((await source.pin(leases[3]!, leases[3]!.holderId, null, quota, leaseRoot)).cut.revision, 4);
    assert.equal(source.pinActive(leases[1]!), true);
    assert.equal(source.pinActive(leases[2]!), true);
  } finally {
    source.close();
    ackStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
