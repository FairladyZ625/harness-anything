// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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

function trySymlink(target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES")) return false;
    throw error;
  }
}

test("ledger clone uses independent files across platforms and excludes symlinks that escape canonical", (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "harness-copy-test-")),
    source = path.join(parent, "canonical"),
    destination = path.join(parent, "isolated"),
    external = path.join(parent, "external.md");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(path.join(source, "context"), { recursive: true });
  writeFileSync(path.join(source, "context", "fact.md"), "canonical\n");
  writeFileSync(external, "outside\n");
  const symlinksSupported =
    trySymlink("context/fact.md", path.join(source, "internal-link.md")) &&
    trySymlink(external, path.join(source, "external-link.md"));

  const result = copyHarnessLedgerWithCow(source, destination);
  if (symlinksSupported) {
    assert.equal(result.excludedExternalSymlinks, 1);
    assert.equal(readFileSync(path.join(destination, "internal-link.md"), "utf8"), "canonical\n");
    assert.equal(lstatSync(path.join(destination, "internal-link.md")).isSymbolicLink(), true);
    assert.equal(
      realpathSync(path.join(destination, "internal-link.md")),
      realpathSync(path.join(destination, "context", "fact.md")),
    );
    assert.equal(existsSync(path.join(destination, "external-link.md")), false);
    writeFileSync(path.join(destination, "internal-link.md"), "branch write\n");
  } else {
    assert.equal(result.excludedExternalSymlinks, 0);
    writeFileSync(path.join(destination, "context", "fact.md"), "branch write\n");
  }

  assert.equal(readFileSync(path.join(source, "context", "fact.md"), "utf8"), "canonical\n");
  assert.equal(readFileSync(path.join(destination, "context", "fact.md"), "utf8"), "branch write\n");
  assert.notEqual(
    statSync(path.join(destination, "context", "fact.md")).ino,
    statSync(path.join(source, "context", "fact.md")).ino,
  );
});

test("ledger clone rejects a destination inside the canonical source", (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "harness-copy-boundary-test-")),
    source = path.join(parent, "canonical"),
    destination = path.join(source, "clone");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(source, { recursive: true });
  assert.throws(() => copyHarnessLedgerWithCow(source, destination), /destination must be outside its source/u);
  assert.equal(existsSync(destination), false);
});

test("runtime ledger clone snapshots SQLite, hard-links immutable CAS objects, and isolates mutable files across platforms", (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "harness-runtime-copy-test-")),
    source = path.join(parent, "canonical"),
    destination = path.join(parent, "isolated"),
    sourceLedger = path.join(source, ".harness", "store", "generations", "3", "ledger.sqlite"),
    sourceCache = path.join(source, ".harness", "cache", "task.sqlite"),
    sourceNonCasObject = path.join(source, ".harness", "store", "generations", "3", "objects", "sha256", "aa", "blob"),
    casBody = "immutable sha256 cas object\n",
    casSha = createHash("sha256").update(casBody).digest("hex"),
    sourceCasObject = path.join(
      source,
      ".harness",
      "store",
      "generations",
      "3",
      "objects",
      "sha256",
      casSha.slice(0, 2),
      casSha.slice(2),
    );
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(path.join(source, "harness"), { recursive: true });
  writeFileSync(path.join(source, "harness", "harness.yaml"), "layout:\n  localRoot: .harness\n");
  mkdirSync(path.dirname(sourceLedger), { recursive: true });
  mkdirSync(path.dirname(sourceNonCasObject), { recursive: true });
  mkdirSync(path.dirname(sourceCasObject), { recursive: true });
  const db = new DatabaseSync(sourceLedger);
  db.exec(
    "CREATE TABLE ledger_meta (repo_id TEXT, generation INTEGER, revision INTEGER); INSERT INTO ledger_meta VALUES ('canonical', 3, 217353);",
  );
  db.close();
  mkdirSync(path.dirname(sourceCache), { recursive: true });
  const cache = new DatabaseSync(sourceCache);
  cache.exec("CREATE TABLE projection_meta (watermark INTEGER); INSERT INTO projection_meta VALUES (217353);");
  cache.close();
  writeFileSync(sourceNonCasObject, "canonical object\n");
  writeFileSync(sourceCasObject, casBody);

  assert.deepEqual(copyHarnessRuntimeLedgerWithCow(source, destination), {
    generation: 3,
    excludedExternalSymlinks: 0,
  });
  const copiedLedger = path.join(destination, ".harness", "store", "generations", "3", "ledger.sqlite"),
    copiedCachePath = path.join(destination, ".harness", "cache", "task.sqlite"),
    copiedNonCasObject = path.join(
      destination,
      ".harness",
      "store",
      "generations",
      "3",
      "objects",
      "sha256",
      "aa",
      "blob",
    ),
    copiedCasObject = path.join(
      destination,
      ".harness",
      "store",
      "generations",
      "3",
      "objects",
      "sha256",
      casSha.slice(0, 2),
      casSha.slice(2),
    ),
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
  const copiedCache = new DatabaseSync(copiedCachePath, { readOnly: true });
  assert.deepEqual({ ...copiedCache.prepare("SELECT watermark FROM projection_meta").get() }, { watermark: 217353 });
  copiedCache.close();

  // Immutable 64-hex CAS object shares inode; SQLite databases and non-CAS files stay isolated.
  assert.equal(statSync(copiedCasObject).ino, statSync(sourceCasObject).ino, "immutable CAS object must share inode");
  assert.ok(statSync(copiedCasObject).nlink >= 2);
  assert.notEqual(statSync(copiedLedger).ino, statSync(sourceLedger).ino, "ledger.sqlite must not share inode");
  assert.notEqual(statSync(copiedCachePath).ino, statSync(sourceCache).ino, "cache/task.sqlite must not share inode");

  writeFileSync(copiedNonCasObject, "isolated object\n");
  assert.equal(readFileSync(sourceNonCasObject, "utf8"), "canonical object\n");
  assert.equal(readFileSync(copiedNonCasObject, "utf8"), "isolated object\n");
});
