// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertCanonicalCliEntry, cliEntryNotCanonicalCode } from "../src/daemon/cli-entry-guard.ts";

const dist = ["packages", "cli", "dist", "cli", "src", "index.js"];

test("a linked worktree CLI dist entry is refused with repair evidence", () => {
  const entry = path.join(path.sep, "repo", ".worktrees", "worker", ...dist);
  assert.throws(
    () => assertCanonicalCliEntry(entry),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, cliEntryNotCanonicalCode);
      assert.match(String(error), new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.match(String(error), /packages\/cli && npm link/u);
      return true;
    },
  );
});

test("the canonical dist entry and any source entry stay eligible", () => {
  assert.doesNotThrow(() => assertCanonicalCliEntry(path.join(path.sep, "repo", ...dist)));
  assert.doesNotThrow(() =>
    assertCanonicalCliEntry(path.join(path.sep, "repo", ".worktrees", "worker", "packages", "cli", "src", "index.ts")),
  );
});
