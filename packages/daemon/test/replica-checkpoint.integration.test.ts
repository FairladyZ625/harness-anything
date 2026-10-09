// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { READ_MODEL_META_PATH, type EdgeReadModelRows, type ReplicaProjectionBasis } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";

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
