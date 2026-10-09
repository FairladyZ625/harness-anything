// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { READ_MODEL_META_PATH, type EdgeReadModelRows, type ReplicaProjectionBasis } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "./replica-sequence.fixture.ts";

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

test("a fixed projection snapshot publishes one complete checkpoint across a revision backlog", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-checkpoint-"));
  const first = lifecycleFixture().events[0]!;
  let revision = 1,
    modelReads = 0;
  const event = (r: number) => ({ ...first, workspaceRevision: r, opId: `op-${r}`, eventId: `event-${r}` });
  const source = openReplicaCutSource({
    repoId: "checkpoint",
    localRoot: root,
    readBasis: (after): ReplicaProjectionBasis => ({
      watermark: revision,
      sourceRevision: revision,
      headEvent: event(revision),
      documents: [],
      events: after === null ? [] : Array.from({ length: revision - after }, (_, i) => event(after + i + 1)),
    }),
    readContentBlob: () => null,
    readEdgeReadModel: (read) => {
      modelReads++;
      return read({ sourceRevision: revision, rootThreshold: 0, rows });
    },
  });
  try {
    source.activate();
    revision = 72;
    const cut = await source.waitForCut(72);
    assert.equal(cut.revision, 72);
    assert.equal(source.cut(2), null, "intermediate revisions are not checkpoints");
    assert.ok(source.cut(1), "backlog must consume one retained checkpoint slot");
    assert.equal(modelReads, 2);
    const meta = source.manifestEntry(72, READ_MODEL_META_PATH)!;
    assert.equal(JSON.parse(Buffer.from(source.content(meta.blob)).toString()).sourceRevision, 72);
    assert.ok(source.changes(1, 72));
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero-change checkpoint links distinguish a complete chain from a missing link", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-checkpoint-chain-"));
  const first = lifecycleFixture().events[0]!;
  let revision = 1;
  const event = (r: number) => ({ ...first, workspaceRevision: r, opId: `op-${r}`, eventId: `event-${r}` });
  const source = openReplicaCutSource({
    repoId: "chain",
    localRoot: root,
    readBasis: (after) => ({
      watermark: revision,
      sourceRevision: revision,
      headEvent: event(revision),
      documents: [],
      events: after === null ? [] : [event(revision)],
    }),
    readContentBlob: () => null,
  });
  try {
    source.activate();
    revision = 72;
    assert.equal((await source.waitForCut(2)).revision, 72);
    revision = 100;
    await source.waitForCut(100);
    assert.deepEqual(source.changes(1, 100), []);
    const { DatabaseSync } = await import("node:sqlite");
    const { READ_MODEL_SCHEMA_GENERATION } = await import("@harness-anything/kernel");
    const db = new DatabaseSync(
      path.join(root, "replica/repos/chain", `g${READ_MODEL_SCHEMA_GENERATION}`, "checkpoints.sqlite"),
    );
    try {
      db.prepare("DELETE FROM link WHERE to_revision=72").run();
    } finally {
      db.close();
    }
    assert.equal(source.changes(1, 100), null);
    assert.deepEqual(source.changes(72, 100), []);
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const size of [200, 2000]) {
  test(`fixed checkpoint completes while writes advance the known head (${size} documents)`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-checkpoint-writing-"));
    const first = lifecycleFixture().events[0]!;
    let live = 1,
      captured = 1,
      writing = false;
    const event = (r: number) => ({ ...first, workspaceRevision: r, opId: `op-${r}`, eventId: `event-${r}` });
    const source = openReplicaCutSource({
      repoId: "writing",
      localRoot: root,
      withReadSnapshot: (read) => {
        captured = live;
        return read();
      },
      readBasis: (after) => ({
        watermark: captured,
        sourceRevision: captured,
        headEvent: event(captured),
        documents: Array.from({ length: size }, (_, i) => ({
          path: `context/${i}.md`,
          blobSha256: "a".repeat(64),
          size: 128,
          mediaType: "text/plain",
        })),
        events: after === null ? [] : Array.from({ length: captured - after }, (_, i) => event(after + i + 1)),
      }),
      readContentBlob: () => null,
      readEdgeReadModel: (read) => {
        if (writing) live += 71;
        return read({ sourceRevision: captured, rootThreshold: 0, rows });
      },
    });
    try {
      source.activate();
      live = 72;
      writing = true;
      const started = performance.now();
      const checkpoint = await source.waitForCut(72);
      assert.equal(checkpoint.revision, 72);
      assert.equal(live, 143);
      assert.ok(source.cut(1));
      assert.equal(source.cut(2), null);
      const meta = source.manifestEntry(72, READ_MODEL_META_PATH)!;
      assert.equal(JSON.parse(Buffer.from(source.content(meta.blob)).toString()).sourceRevision, 72);
      t.diagnostic(`${size} documents: published R=72 while H=143 in ${performance.now() - started}ms`);
    } finally {
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
