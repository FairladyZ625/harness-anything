// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncFile, writeFileDurably } from "../src/durable-file.ts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

test("a durable write lands the whole body and leaves no temporary behind", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "durable-file-"));
  const target = path.join(root, "nested", "state.json");
  writeFileDurably(target, `${JSON.stringify({ revision: 1 })}\n`);
  assert.equal(readFileSync(target, "utf8"), '{"revision":1}\n');
  assert.deepEqual(readdirSync(path.dirname(target)), ["state.json"]);
  writeFileDurably(target, `${JSON.stringify({ revision: 2 })}\n`, 0o600);
  assert.equal(readFileSync(target, "utf8"), '{"revision":2}\n');
  assert.deepEqual(readdirSync(path.dirname(target)), ["state.json"]);
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(existsSync(`${target}.tmp`), false);
});

// #1586 was one defect repeated in six modules and fixed in three of them, because each module
// restated the flush sequence itself. Windows rejects fsync on a read-only handle, so a bare
// `openSync(target, "r")` anywhere in this package is that defect coming back; the port is the
// one place allowed to hold such a handle, and only for a directory it then skips on win32.
test("#1586: a read-only handle is opened for flushing in exactly one module", () => {
  const offenders = sourceFiles(sourceRoot)
    .filter((file) => /openSync\([^)]*, "r"\)/u.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(sourceRoot, file));
  assert.deepEqual(offenders, ["durable-file.ts"]);
});

test("#1586: flushing a file uses a writable handle, which Windows requires", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "durable-file-"));
  const target = path.join(root, "chunk.bin");
  writeFileDurably(target, new Uint8Array([1, 2, 3]));
  syncFile(target);
  assert.deepEqual([...readFileSync(target)], [1, 2, 3]);
});
