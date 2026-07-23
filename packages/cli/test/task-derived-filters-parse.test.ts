// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";

test("task list parses hierarchy and liveness filters", () => {
  const parsed = parseArgs(["task", "list", "--tree-root", "task_root", "--parent", "task_parent", "--liveness", "stale"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "task-list") return;
  assert.equal(parsed.value.action.filters.treeRoot, "task_root");
  assert.equal(parsed.value.action.filters.parent, "task_parent");
  assert.equal(parsed.value.action.filters.liveness, "stale");
});
