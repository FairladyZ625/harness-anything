// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readMigrationProjectionOracle } from "../src/migration-import-oracle.ts";

test("same-cut oracle rejects a projection watermark that differs from canonical event head", () => {
  const root = mkdtempSync(path.join(tmpdir(), "migration-oracle-cut-")),
    authored = path.join(root, "harness"),
    local = path.join(root, ".harness/cache");
  try {
    mkdirSync(path.join(authored, "events"), { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(
      path.join(authored, "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    writeFileSync(path.join(authored, "events/head.json"), '{"revision":7}\n');
    const database = new DatabaseSync(path.join(local, "task.sqlite"));
    database.exec("CREATE TABLE projection_meta(singleton INTEGER PRIMARY KEY, watermark INTEGER NOT NULL)");
    database.prepare("INSERT INTO projection_meta VALUES(1, 6)").run();
    database.close();
    assert.throws(
      () => readMigrationProjectionOracle(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { readonly code?: string }).code === "migration_projection_oracle_cut_mismatch" &&
        /watermark 6.*head 7/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
