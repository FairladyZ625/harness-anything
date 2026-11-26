// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";
import { sqliteDatabasePath } from "../../src/sqlite-database-path.ts";

test("sqliteDatabasePath leaves non-Windows, URI, memory, and short paths unchanged", () => {
  const longUnix = `/${"a".repeat(280)}/ledger.sqlite`;
  assert.equal(sqliteDatabasePath(longUnix, "linux"), longUnix);
  assert.equal(sqliteDatabasePath(longUnix, "darwin"), longUnix);
  assert.equal(sqliteDatabasePath(":memory:", "win32"), ":memory:");
  assert.equal(
    sqliteDatabasePath("file:///C:/short/ledger.sqlite?immutable=1", "win32"),
    "file:///C:/short/ledger.sqlite?immutable=1",
  );
  assert.equal(
    sqliteDatabasePath("\\\\?\\C:\\already\\prefixed\\ledger.sqlite", "win32"),
    "\\\\?\\C:\\already\\prefixed\\ledger.sqlite",
  );
  assert.equal(sqliteDatabasePath("C:\\short\\ledger.sqlite", "win32"), "C:\\short\\ledger.sqlite");
});

test("sqliteDatabasePath prefixes long Windows drive and UNC paths", () => {
  const longDrive = `C:\\Users\\runneradmin\\AppData\\Local\\Temp\\${"segment\\".repeat(30)}ledger.sqlite`;
  assert.equal(sqliteDatabasePath(longDrive, "win32"), `\\\\?\\${path.win32.resolve(longDrive)}`);

  const longUnc = `\\\\fileserver\\share\\${"segment\\".repeat(30)}ledger.sqlite`;
  assert.equal(sqliteDatabasePath(longUnc, "win32"), `\\\\?\\UNC\\${path.win32.resolve(longUnc).slice(2)}`);
});

test("node:sqlite opens, writes WAL, and reads a >260-char path via sqliteDatabasePath", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-sqlite-long-"));
  t.after(() => removeTempRepository(root));
  const deepDir = path.join(root, "a".repeat(70), "b".repeat(70), "c".repeat(70), "d".repeat(50));
  mkdirSync(deepDir, { recursive: true });
  const dbPath = path.join(deepDir, "ledger.sqlite");
  assert.ok(dbPath.length > 260, `expected >260 char path, got ${dbPath.length}`);

  const writer = new DatabaseSync(sqliteDatabasePath(dbPath));
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'ok');",
    );
  } finally {
    writer.close();
  }

  const reader = new DatabaseSync(sqliteDatabasePath(dbPath), { readOnly: true });
  try {
    const row = reader.prepare("SELECT v FROM t WHERE k = 1").get() as { readonly v: string };
    assert.equal(row.v, "ok");
  } finally {
    reader.close();
  }
});
