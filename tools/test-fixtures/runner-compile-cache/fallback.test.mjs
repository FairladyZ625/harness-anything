// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// The compile cache must live outside the checkout: a task worktree is reclaimed when its task
// closes, and a process from an earlier run that outlives the reclaim re-creates directories
// under the dead path on its next lazy cache write.
test("the runner's compile cache is outside the checkout a reclaimed worktree leaves behind", () => {
  const checkoutRoot = path.resolve(import.meta.dirname, "../../.."),
    cache = process.env.NODE_COMPILE_CACHE;
  assert.ok(cache, "the runner sets NODE_COMPILE_CACHE for every child it spawns");
  assert.ok(path.isAbsolute(cache), cache);
  assert.ok(!cache.startsWith(`${checkoutRoot}${path.sep}`), cache);
});
