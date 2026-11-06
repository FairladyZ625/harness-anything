// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";
import { taskPresentationReads } from "../src/task-presentation-read.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";

function seedProjection(rootDir: string, repoId: string, taskId: string) {
  const eventStore = makeTaskEventStore({ repoId, rootDir }),
    events = lifecycleFixture({ taskId }).events,
    projection = makeTaskProjection({ rootDir, eventStore });
  for (const event of events) {
    const plan = taskLifecycleWritePlan(event);
    eventStore.append({ event, plan, blobs: [] });
    projection.apply(event, plan);
  }
  projection.close();
  return { eventStore, path: projection.path };
}

function storedSnapshot(path: string, taskId: string) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get(taskId) as {
      readonly snapshot_json: string;
    };
  } finally {
    db.close();
  }
}

function readModel(projection: ReturnType<typeof makeTaskProjection>, rootDir: string) {
  return makeTaskQueryReadModel({
    rootDir: canonicalRoot(rootDir),
    projection,
    readPinnedEntities: () => [],
    judgments: {
      closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
      blocking: (() => []) as never,
    },
  });
}

/**
 * The July-era migration importer stored `snapshot_json.task` without `packageDisposition`, while
 * the generated `package_disposition` column already answered `active`. A task read used to throw
 * `missing packageDisposition` and abort the whole GUI page for those rows (#4353).
 */
test("a stored task without packageDisposition reads as active through presentation and GUI reads", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const repoId = "package-disposition-default",
      taskId = "task_imported_without_disposition",
      { eventStore, path } = seedProjection(rootDir, repoId, taskId),
      before = storedSnapshot(path, taskId),
      stored = JSON.parse(before.snapshot_json) as { readonly task?: Record<string, unknown> };
    assert.equal(Object.hasOwn(stored.task!, "packageDisposition"), false, "fixture must freeze the old shape");

    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      projection.catchUp();
      const presentation = taskPresentationReads(projection).list({ limit: 10 });
      assert.equal(presentation.rows.length, 1);
      assert.equal(presentation.rows[0]!.snapshot.task!.packageDisposition, "active");

      const gui = readModel(projection, rootDir).guiTasks();
      assert.deepEqual(gui.invalidRows, []);
      assert.equal(gui.rows.length, 1);
      assert.equal(gui.rows[0]!.placement.packageDisposition, "active");
      assert.equal(gui.rows[0]!.placement.origin, "native");
    } finally {
      projection.close();
    }
    // The read concludes; it never rewrites the stored snapshot bytes.
    assert.deepEqual(storedSnapshot(path, taskId), before);
  });
});

test("a stored task with an illegal packageDisposition is still rejected", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const repoId = "package-disposition-illegal",
      taskId = "task_imported_illegal_disposition",
      { eventStore, path } = seedProjection(rootDir, repoId, taskId),
      stored = JSON.parse(storedSnapshot(path, taskId).snapshot_json) as { task: Record<string, unknown> };
    stored.task.packageDisposition = "quarantined";
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE task_snapshot SET snapshot_json = ? WHERE task_id = ?").run(JSON.stringify(stored), taskId);
    } finally {
      db.close();
    }

    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      projection.catchUp();
      assert.throws(() => taskPresentationReads(projection).list({ limit: 10 }), /projection snapshot mismatch/u);
      assert.throws(() => readModel(projection, rootDir).guiTasks(), /projection snapshot mismatch/u);
    } finally {
      projection.close();
    }
  });
});
