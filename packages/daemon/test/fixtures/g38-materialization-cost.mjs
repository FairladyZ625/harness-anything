import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installSqliteWorkProbe, resetSqliteWork, snapshotSqliteWork } from "./g38-sqlite-work.mjs";

const load = (root, relative) => import(pathToFileURL(path.join(root, relative)).href);

/** dec_D0460C1DBD540A8641B4E78F7F/CH1: one terminal transition visits only its indexed degree. */
export async function measureTerminalMaterialization(root, size) {
  installSqliteWorkProbe();
  const [{ DatabaseSync }, fixtures, { withTempStore }, { settleTerminalMaterializationForEvent }] = await Promise.all([
    import("node:sqlite"),
    load(root, "packages/storage/test/store/relation-graph-projection.fixtures.ts"),
    load(root, "packages/storage/test/store/helpers.ts"),
    load(root, "packages/storage/src/projection/rebuildable-task-projection-write-model.ts"),
  ]);
  return withTempStore((storeRoot) => {
    const fixture = fixtures.projectionFixture(storeRoot),
      event = fixtures.taskCreated(1, "task_hot");
    fixture.appendEvent(event);
    fixture.projection.apply(event);
    fixtures.applyFact(fixture, fixtures.fact(2));
    const file = fixture.projection.path;
    fixture.projection.close();
    const db = new DatabaseSync(file);
    try {
      const snapshot = JSON.parse(
          db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id='task_hot'").get().snapshot_json,
        ),
        fact = JSON.parse(db.prepare("SELECT row_json FROM fact LIMIT 1").get().row_json),
        insertFact = db.prepare(
          "INSERT INTO fact(task_id,fact_id,ref,statement,evidence_source,observed_at,confidence,memory_class,op_id,workspace_revision,row_json) SELECT 'task_hot',?,?,statement,evidence_source,observed_at,confidence,memory_class,?,2,? FROM fact WHERE fact_id='F-DEADBEEF'",
        ),
        insertEdge = db.prepare(
          "INSERT INTO relation_edge(relation_id,source_ref,target_ref,relation_type,state,owner_ref,workspace_revision,updated_at,row_json) VALUES (?,?,?,'produces','active',?,2,'2026-11-14T00:00:00Z','{}')",
        ),
        insertDoc = db.prepare("INSERT INTO document(path,workspace_revision,value_json) VALUES (?,2,?)");
      // Cold, unrelated edges are a negative control against global relation scans.
      db.exec("BEGIN");
      for (let i = 0; i < size; i++) {
        const id = `F-${i.toString(16).toUpperCase().padStart(8, "0")}`,
          ref = `fact/${id}`,
          target = `facts/${id}.md`;
        insertFact.run(id, ref, `fact-${i}`, JSON.stringify({ ...fact, factId: id, ref, archived: true }));
        insertEdge.run(`hot-${i}`, "task/task_hot", ref, "task/task_hot");
        insertEdge.run(`cold-${i}`, "task/task_cold", "fact/F-DEADBEEF", "task/task_cold");
        db.prepare("INSERT INTO materialization_hold VALUES (?,?)").run(ref, `hot-${i}`);
        insertDoc.run(
          target,
          JSON.stringify({
            path: target,
            body: "retained",
            blobSha256: "a".repeat(64),
            size: 8,
            mediaType: "text/markdown",
          }),
        );
      }
      db.prepare("UPDATE task_snapshot SET status='cancelled',snapshot_json=? WHERE task_id='task_hot'").run(
        JSON.stringify({ ...snapshot, task: { ...snapshot.task, status: "cancelled" } }),
      );
      db.exec("COMMIT");
      resetSqliteWork();
      settleTerminalMaterializationForEvent(db, { ...event, type: "task_transitioned", workspaceRevision: 3 });
      const counts = snapshotSqliteWork();
      assert.equal(db.prepare("SELECT count(*) AS n FROM document_history WHERE path LIKE 'facts/F-0%'").get().n, size);
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM materialization_hold WHERE relation_id LIKE 'hot-%'").get().n,
        0,
      );
      return { size, counts };
    } finally {
      db.close();
    }
  });
}

/** CH3: fixed working set, growing done packages and event history. Real SQL work, not returned-row counts. */
export async function measureColdMaterialization(root, size, policy = "in_flight", incremental = false) {
  installSqliteWorkProbe();
  const [{ DatabaseSync }, fixtures, { withTempStore }, { readNodeMaterializationDocuments }] = await Promise.all([
    import("node:sqlite"),
    load(root, "packages/storage/test/store/relation-graph-projection.fixtures.ts"),
    load(root, "packages/storage/test/store/helpers.ts"),
    load(root, "packages/storage/src/storage-backend.ts"),
  ]);
  return withTempStore((storeRoot) => {
    const fixture = fixtures.projectionFixture(storeRoot),
      event = fixtures.taskCreated(1, "task_hot");
    fixture.appendEvent(event);
    fixture.projection.apply(event);
    const file = fixture.projection.path;
    fixture.projection.close();
    const db = new DatabaseSync(file);
    try {
      const snapshot = JSON.parse(
          db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id='task_hot'").get().snapshot_json,
        ),
        insertSnapshot = db.prepare(
          "INSERT INTO task_snapshot(task_id,workspace_revision,snapshot_json,status,updated_at) VALUES (?,1,?,'done','2026-11-14T00:00:00Z')",
        ),
        insertDoc = db.prepare("INSERT INTO document(path,workspace_revision,value_json) VALUES (?,1,?)"),
        addDoc = (target) =>
          insertDoc.run(
            target,
            JSON.stringify({
              path: target,
              body: "content",
              blobSha256: "a".repeat(64),
              size: 7,
              mediaType: "text/markdown",
            }),
          );
      db.exec("BEGIN");
      db.prepare("INSERT OR REPLACE INTO task_package VALUES (?,?)").run("task_hot", "tasks/task_hot");
      addDoc("context/architecture.md");
      addDoc("tasks/task_hot/task_plan.md");
      for (let i = 0; i < size; i++) {
        const id = `task_done_${i}`;
        insertSnapshot.run(id, JSON.stringify({ ...snapshot, task: { ...snapshot.task, taskId: id, status: "done" } }));
        db.prepare("INSERT INTO task_package VALUES (?,?)").run(id, `tasks/${id}`);
        addDoc(`tasks/${id}/task_plan.md`);
        db.prepare("INSERT INTO event_index(op_id,workspace_revision,task_id,event_json) VALUES (?,?,?,'{}')").run(
          `cold-${i}`,
          i + 2,
          id,
        );
      }
      if (incremental)
        db.prepare("UPDATE document SET workspace_revision=2 WHERE path IN (?,?)").run(
          "context/architecture.md",
          "tasks/task_hot/task_plan.md",
        );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const projection = fixture.reopen();
    try {
      projection.readCut(); // Initialize the connection outside the measurement.
      resetSqliteWork();
      const documents = readNodeMaterializationDocuments(projection, policy, [], incremental ? 1 : undefined),
        counts = snapshotSqliteWork();
      assert.deepEqual(
        documents.map(({ path }) => path),
        policy === "none" ? [] : ["context/architecture.md", "tasks/task_hot/task_plan.md"],
      );
      // The observer's own g38_read_work SELECT contributes 12 fixed VM steps.
      if (policy === "none") assert.deepEqual(counts, { sqliteVmSteps: 12, sqliteScanPages: 0 });
      return { size, counts };
    } finally {
      projection.close();
    }
  });
}

export const MATERIALIZATION_PROBES = Object.freeze({
  ...Object.fromEntries(
    ["task-transition", "task-complete", "task-archive", "relation-unrelate"].map((action) => [
      `${action}:materialization-degree`,
      { action, dimension: "materialization-degree", run: measureTerminalMaterialization },
    ]),
  ),
  "doc-materialize:cold-history": {
    action: "doc-materialize",
    dimension: "cold-history",
    growth: "constant",
    run: measureColdMaterialization,
  },
  "doc-materialize:incremental-history": {
    action: "doc-materialize",
    dimension: "incremental-history",
    growth: "constant",
    run: (root, n) => measureColdMaterialization(root, n, "in_flight", true),
  },
  "doc-materialize:none-history": {
    action: "doc-materialize",
    dimension: "none-history",
    growth: "constant",
    run: (root, n) => measureColdMaterialization(root, n, "none"),
  },
});
