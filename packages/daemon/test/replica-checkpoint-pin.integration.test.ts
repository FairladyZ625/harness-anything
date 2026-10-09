// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { READ_MODEL_SCHEMA_GENERATION, type EdgeReadModelRows } from "@harness-anything/kernel";
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
      const target = await source.pin(
        lease,
        null,
        termination === "quota" ? 1000 : 1_000_000,
        path.join(root, "center"),
      );
      const other = await source.pin(second, null, 1_000_000, path.join(root, "center"));
      assert.deepEqual(target, other);
      assert.equal(builds, 1, "two edges share one build");
      const offer = ackStore.offer(key, await makeOffer(key, null, target, source, new Date().toISOString()));
      const frames = offerFrames(offer, source, { owner: "person", digest: "a".repeat(64) });
      assert.equal((await frames.next()).value?.schema, "fleet.snapshot.begin/v1");
      for (revision = 2; revision <= 66; revision++) await source.waitForCut(revision);
      assert.ok(source.cut(1), "other edge still owns its pin");
      if (termination === "quota") {
        assert.equal(source.pinActive(lease), false, "quota explicitly revokes the pin");
        ackStore.delivery.release(lease);
      } else {
        assert.equal(source.pinActive(lease), true);
        let bytes = 0;
        for await (const frame of frames)
          if (frame.schema === "fleet.snapshot.chunk/v1") bytes += Buffer.from(frame.dataBase64, "base64").length;
        assert.ok(bytes > 0);
        t.diagnostic(`snapshot begin -> 65 publications -> ${bytes} bytes -> ${termination}`);
        if (termination === "ack") {
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
          t.mock.method(Date, "now", () => lease.expiresAt + 1);
          assert.equal(
            ackStore.ack(
              key,
              offer.transferId,
              offer.toCut,
              offer.manifestDigest,
              new Date(lease.expiresAt + 1).toISOString(),
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
