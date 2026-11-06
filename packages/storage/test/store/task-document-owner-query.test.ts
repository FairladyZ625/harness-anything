// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TASK_INDEX_TABLES_SQL } from "../../src/projection/projection-tables.ts";
import { readTaskDocumentOwner } from "../../src/projection/task-document-owner-query.ts";

function ledger(rows: readonly (readonly [string, string])[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(TASK_INDEX_TABLES_SQL);
  for (const [taskId, packagePath] of rows)
    db.prepare("INSERT INTO task_package(task_id, package_path) VALUES (?, ?)").run(taskId, packagePath);
  return db;
}

function owner(db: DatabaseSync, path: string): string | null {
  return readTaskDocumentOwner(path, (sql) => db.prepare(sql));
}

test("task package owner prefers the longest registered ancestor and honors exact equality", () => {
  const db = ledger([
    ["parent", "tasks/parent"],
    ["child", "tasks/parent/nested"],
    ["other", "tasks/other"],
  ]);
  try {
    assert.equal(owner(db, "tasks/parent/nested/a.md"), "child");
    assert.equal(owner(db, "tasks/parent/nested"), "child");
    assert.equal(owner(db, "tasks/parent/a.md"), "parent");
    assert.equal(owner(db, "tasks/parentish/a.md"), null);
    assert.equal(owner(db, "tasks/parent-other/a.md"), null);
    assert.equal(owner(db, "tasks/missing/a.md"), null);
  } finally {
    db.close();
  }
});

test("task package owner preserves literal prefix semantics for repeated and trailing slashes", () => {
  const db = ledger([
    ["slash", "tasks/a"],
    ["repeated", "tasks/a/"],
    ["deep", "tasks/a//b"],
  ]);
  try {
    assert.equal(owner(db, "tasks/a//b/c.md"), "deep");
    assert.equal(owner(db, "tasks/a//c.md"), "repeated");
    assert.equal(owner(db, "tasks/a/b.md"), "slash");
    assert.equal(owner(db, "tasks/a/"), "repeated");
    assert.equal(owner(db, "tasks/a"), "slash");
    assert.equal(owner(db, ""), null);
  } finally {
    db.close();
  }
});
