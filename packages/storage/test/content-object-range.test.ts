// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { objectPath, readContentObjectRange } from "../src/store/content-objects.ts";

test("content object range reads are bounded and resume at the requested offset", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-content-range-")),
    digest = "a".repeat(64),
    target = objectPath(root, digest),
    bytes = Buffer.from("0123456789abcdef");
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    assert.deepEqual(readContentObjectRange(root, digest, 3, 5), Buffer.from("34567"));
    assert.deepEqual(readContentObjectRange(root, digest, 14, 99), Buffer.from("ef"));
    assert.equal(readContentObjectRange(root, digest, bytes.byteLength, 5)?.byteLength, 0);
    assert.throws(() => readContentObjectRange(root, digest, -1, 5), RangeError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
