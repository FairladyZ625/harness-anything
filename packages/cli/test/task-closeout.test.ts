// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("task closeout keeps the execution selector optional and packet input required", () => {
  const derived = parseThinCommand(["task", "closeout", "task-closeout", "--from-file", "judgment.json"]), explicit = parseThinCommand(["task", "closeout", "task-closeout", "--execution-id", "execution-closeout", "--from-file", "judgment.json"]), missing = parseThinCommand(["task", "closeout", "task-closeout"]);
  assert.equal(derived.ok, true); assert.equal(explicit.ok, true); assert.equal(missing.ok, false);
  if (derived.ok) assert.deepEqual(derived.command.action, { kind: "task-closeout", taskId: "task-closeout", fromFile: "judgment.json" });
  if (explicit.ok) assert.deepEqual(explicit.command.action, { kind: "task-closeout", taskId: "task-closeout", executionId: "execution-closeout", fromFile: "judgment.json" });
});
