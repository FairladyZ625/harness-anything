// harness-test-tier: fast
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyHarnessLedgerWithCow,
  copyHarnessRuntimeLedgerWithCow,
} from "../../packages/gui/test-support/harness-copy.mjs";

test("ledger clone uses independent CoW files and excludes symlinks that escape canonical", (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires macOS APFS clonefile support");
    return;
  }
  const parent = mkdtempSync(path.join(tmpdir(), "harness-copy-test-")),
    source = path.join(parent, "canonical"),
    destination = path.join(parent, "isolated"),
    external = path.join(parent, "external.md");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(path.join(source, "context"), { recursive: true });
  writeFileSync(path.join(source, "context", "fact.md"), "canonical\n");
  writeFileSync(external, "outside\n");
  symlinkSync("context/fact.md", path.join(source, "internal-link.md"));
  symlinkSync(external, path.join(source, "external-link.md"));

  const result = copyHarnessLedgerWithCow(source, destination);
  assert.equal(result.excludedExternalSymlinks, 1);
  assert.equal(readFileSync(path.join(destination, "internal-link.md"), "utf8"), "canonical\n");
  assert.equal(lstatSync(path.join(destination, "internal-link.md")).isSymbolicLink(), true);
  assert.equal(realpathSync(path.join(destination, "internal-link.md")), path.join(destination, "context", "fact.md"));
  assert.equal(existsSync(path.join(destination, "external-link.md")), false);

  writeFileSync(path.join(destination, "internal-link.md"), "branch write\n");
  assert.equal(readFileSync(path.join(source, "context", "fact.md"), "utf8"), "canonical\n");
  assert.equal(readFileSync(path.join(destination, "context", "fact.md"), "utf8"), "branch write\n");
});

test("ledger clone rejects a destination inside the canonical source", (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires macOS APFS clonefile support");
    return;
  }
  const parent = mkdtempSync(path.join(tmpdir(), "harness-copy-boundary-test-")),
    source = path.join(parent, "canonical"),
    destination = path.join(source, "clone");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(source, { recursive: true });
  assert.throws(() => copyHarnessLedgerWithCow(source, destination), /destination must be outside its source/u);
  assert.equal(existsSync(destination), false);
});

test("runtime ledger clone snapshots SQLite and CoW-copies immutable objects", (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires macOS APFS clonefile support");
    return;
  }
  const parent = mkdtempSync(path.join(tmpdir(), "harness-runtime-copy-test-")),
    source = path.join(parent, "canonical"),
    destination = path.join(parent, "isolated"),
    sourceLedger = path.join(source, ".harness", "store", "generations", "3", "ledger.sqlite"),
    sourceCache = path.join(source, ".harness", "cache", "task.sqlite"),
    sourceObject = path.join(source, ".harness", "store", "generations", "3", "objects", "sha256", "aa", "blob");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(path.join(source, "harness"), { recursive: true });
  writeFileSync(path.join(source, "harness", "harness.yaml"), "layout:\n  localRoot: .harness\n");
  mkdirSync(path.dirname(sourceLedger), { recursive: true });
  mkdirSync(path.dirname(sourceObject), { recursive: true });
  const db = new DatabaseSync(sourceLedger);
  db.exec(
    "CREATE TABLE ledger_meta (repo_id TEXT, generation INTEGER, revision INTEGER); INSERT INTO ledger_meta VALUES ('canonical', 3, 217353);",
  );
  db.close();
  mkdirSync(path.dirname(sourceCache), { recursive: true });
  const cache = new DatabaseSync(sourceCache);
  cache.exec("CREATE TABLE projection_meta (watermark INTEGER); INSERT INTO projection_meta VALUES (217353);");
  cache.close();
  writeFileSync(sourceObject, "canonical object\n");

  assert.deepEqual(copyHarnessRuntimeLedgerWithCow(source, destination), {
    generation: 3,
    excludedExternalSymlinks: 0,
  });
  const copiedLedger = path.join(destination, ".harness", "store", "generations", "3", "ledger.sqlite"),
    copiedObject = path.join(destination, ".harness", "store", "generations", "3", "objects", "sha256", "aa", "blob"),
    copy = new DatabaseSync(copiedLedger, { readOnly: true });
  assert.deepEqual(
    { ...copy.prepare("SELECT repo_id, generation, revision FROM ledger_meta").get() },
    {
      repo_id: "canonical",
      generation: 3,
      revision: 217353,
    },
  );
  copy.close();
  const copiedCache = new DatabaseSync(path.join(destination, ".harness", "cache", "task.sqlite"), { readOnly: true });
  assert.deepEqual({ ...copiedCache.prepare("SELECT watermark FROM projection_meta").get() }, { watermark: 217353 });
  copiedCache.close();
  writeFileSync(copiedObject, "isolated object\n");
  assert.equal(readFileSync(sourceObject, "utf8"), "canonical object\n");
  assert.equal(readFileSync(copiedObject, "utf8"), "isolated object\n");
});
