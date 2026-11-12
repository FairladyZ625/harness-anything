// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateStorageReadWindow } from "../../src/domain/storage-read-policy.ts";

test("storage read windows preserve endpoint ceilings and reject invalid rows and revisions", () => {
  for (const [, maximum] of [
    ["standard", 500],
    ["summaries", 2048],
    ["sessions", 64],
  ] as const) {
    assert.equal(validateStorageReadWindow(1, maximum, 0), true);
    assert.equal(validateStorageReadWindow(maximum, maximum, Number.MAX_SAFE_INTEGER), true);
    assert.equal(validateStorageReadWindow(maximum + 1, maximum, 0), false);
    for (const rows of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validateStorageReadWindow(rows, maximum), false);
    for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validateStorageReadWindow(1, maximum, revision), false);
  }
  assert.equal(validateStorageReadWindow(Number.MAX_SAFE_INTEGER), true);
});
