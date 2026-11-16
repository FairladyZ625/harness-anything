// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import { readDocumentRows } from "../../src/projection/repository-event-queries.ts";
import { readNodeMaterializationDocuments, requireTaskMaterializationMetadata } from "../../src/storage-backend.ts";

const ordinary = [
  "tasks/_pending-issue-triage-20260818/report.md",
  "tasks/task/notes.md",
  "tasks/task`/notes.md",
  "tasks0/notes.md",
];
const taskPath = "tasks/task_example/task_plan.md";

test("SQLite task exclusion uses the exact task_ prefix and preserves paged free documents", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE document (path TEXT PRIMARY KEY, value_json TEXT, workspace_revision INTEGER)");
    const put = db.prepare("INSERT INTO document VALUES (?, ?, 1)");
    for (const path of [...ordinary, taskPath])
      put.run(path, JSON.stringify({ blobSha256: "digest", size: 4, mediaType: "text/markdown" }));
    let afterPath: string | undefined;
    const paths: string[] = [];
    for (;;) {
      const rows = readDocumentRows(db, "", { limit: 1, afterPath, excludeTaskPackages: true });
      if (!rows.length) break;
      paths.push(rows[0]!.path);
      afterPath = rows[0]!.path;
    }
    assert.deepEqual(paths, [...ordinary].sort());
    assert.deepEqual(readDocumentRows(db, "tasks/task_", { limit: 10, excludeTaskPackages: true }), []);
  } finally {
    db.close();
  }
});

test("free task-directory documents need no Task metadata for full or incremental materialization", () => {
  const documents = ordinary.map((path) => ({
    path,
    blobSha256: "digest",
    size: 4,
    mediaType: "text/markdown",
    policyId: null,
  }));
  const q = {
    readDocuments: () => ({ status: "ready", watermark: 2, sourceRevision: 2, documents, page: { nextPath: null } }),
    taskIdForDocumentPath: () => null,
    readTaskIndex: () => ({ rows: [] }),
  } as unknown as TaskProjectionQueries;
  assert.doesNotThrow(() => requireTaskMaterializationMetadata(q, ordinary));
  assert.throws(
    () => requireTaskMaterializationMetadata(q, [taskPath]),
    /Task materialization metadata is unavailable/u,
  );
  assert.deepEqual(readNodeMaterializationDocuments(q, "in_flight", [], undefined, ordinary), documents);
  assert.deepEqual(
    readNodeMaterializationDocuments(q, "in_flight", [], 1),
    documents.map((doc) => ({ ...doc, retired: false })),
  );
  const incomplete = {
    ...q,
    readDocuments: () => ({
      status: "ready",
      watermark: 2,
      sourceRevision: 2,
      documents: [{ ...documents[0]!, path: taskPath }],
      page: { nextPath: null },
    }),
  } as unknown as TaskProjectionQueries;
  assert.throws(
    () => readNodeMaterializationDocuments(incomplete, "in_flight", [], 1),
    /Task materialization metadata is unavailable/u,
  );
});
