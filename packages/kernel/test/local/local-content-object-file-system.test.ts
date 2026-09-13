// harness-test-tier: fast
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localContentObjectFileSystem } from "../../src/local/local-layout-file-system.ts";

test("a content-object batch fsyncs every file and each shared directory once", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-content-batch-")),
    directory = path.join(root, "objects", "ab"),
    first = path.join(directory, "first"),
    second = path.join(directory, "second"),
    original = fs.fsyncSync;
  let syncs = 0;
  const spy = t.mock.method(fs, "fsyncSync", (descriptor) => {
    syncs += 1;
    return original(descriptor);
  });
  syncBuiltinESMExports();
  try {
    localContentObjectFileSystem.replaceMany([
      { path: first, body: "one" },
      { path: second, body: "two" },
    ]);
    assert.equal(syncs, process.platform === "win32" ? 2 : 5);
    assert.equal(readFileSync(first, "utf8"), "one");
    assert.equal(readFileSync(second, "utf8"), "two");
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});
