// harness-test-tier: integration
import path from "node:path";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { centerEdgeReadModel } from "../src/fleet/replica-read-model.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { makeTaskProjection } from "../../kernel/src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../kernel/src/store/task-event-store.ts";
import { taskLifecycleWritePlan } from "../../kernel/src/domain/task-lifecycle-publication.ts";
import { edgeReadModelEntries } from "../../kernel/src/projection/read-model.ts";
import { sha256Text, stableStringify } from "../../kernel/src/integrity/stable-hash.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";

test("local reservation changes exported read-model bytes without advancing the canonical revision", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const git = (...args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { stdio: "ignore" });
    git("init", "--quiet");
    git("config", "user.name", "Replica Boundary Fixture");
    git("config", "user.email", "replica-boundary@example.invalid");
    git("commit", "--allow-empty", "--quiet", "-m", "fixture base");
    const eventStore = makeTaskEventStore({ repoId: "replica-boundary", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    try {
      const [created, started] = lifecycleFixture().events;
      if (!created || started?.type !== "execution_started") throw new Error("start fixture required");
      eventStore.append({ event: created, plan: taskLifecycleWritePlan(created), blobs: [] });
      projection.apply(created);
      let checkpointNumber = 0;
      const checkpoint = () => {
        const source = openReplicaCutSource({
          repoId: "replica-boundary",
          localRoot: path.join(rootDir, `checkpoint-${checkpointNumber++}`),
          readBasis: projection.readReplicaBasis,
          readContentBlob: eventStore.readContentBlob,
          readEdgeReadModel: (read) => centerEdgeReadModel(projection, read),
        });
        try {
          return source.activate()!;
        } finally {
          source.close();
        }
      };
      const read = () =>
        projection.readEdgeReadModel((model) => ({
          revision: model.sourceRevision,
          leases: model.rows.leases,
          digest: sha256Text(
            stableStringify([
              ...edgeReadModelEntries({ sourceRevision: model.sourceRevision, rootThreshold: 3, rows: model.rows }),
            ]),
          ),
        }));
      const head = eventStore.readHead();
      const before = read(),
        firstCheckpoint = checkpoint();
      const lease = projection.reserveLease(
        { ...started.payload.lease, phase: "reserving", version: 0 },
        started.occurredAt,
      );
      const reserved = read(),
        reservedCheckpoint = checkpoint();
      assert.deepEqual(eventStore.readHead(), head);
      assert.equal(reserved.revision, before.revision);
      assert.equal(before.leases.length, 0);
      assert.equal(JSON.parse(reserved.leases[0]!.leaseJson).phase, "reserving");
      assert.notEqual(reserved.digest, before.digest);
      projection.releaseLease(lease);
      const released = read(),
        releasedCheckpoint = checkpoint();
      assert.deepEqual(eventStore.readHead(), head);
      assert.equal(released.revision, before.revision);
      assert.notEqual(released.digest, reserved.digest);
      assert.equal(firstCheckpoint.revision, reservedCheckpoint.revision);
      assert.equal(firstCheckpoint.revision, releasedCheckpoint.revision);
      assert.equal(firstCheckpoint.headDigest, reservedCheckpoint.headDigest);
      assert.equal(firstCheckpoint.headDigest, releasedCheckpoint.headDigest);
      assert.notEqual(firstCheckpoint.manifest.digest, reservedCheckpoint.manifest.digest);
      assert.notEqual(reservedCheckpoint.manifest.digest, releasedCheckpoint.manifest.digest);
      t.diagnostic(
        JSON.stringify({
          canonicalRevision: head?.revision,
          before,
          reserved,
          released,
          firstCheckpoint,
          reservedCheckpoint,
          releasedCheckpoint,
        }),
      );
    } finally {
      projection.close();
      await eventStore.drain();
    }
  });
});
