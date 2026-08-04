// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { commandRegistry } from "../src/cli/command-registry.ts";
import { commandGroups } from "../src/cli/command-spec/command-groups.ts";
import { parseArgs } from "../src/cli/parse-args.ts";

test("every primary-workflow line names a registered command path", () => {
  const registeredPaths = commandRegistry.map((entry) => entry.commandPath);
  for (const group of commandGroups) {
    for (const line of group.primaryWorkflow ?? []) {
      const tokens = line
        .split(/\s+/u)
        .slice(1)
        .filter((token) => !token.startsWith("-") && !token.startsWith("<"));
      const matched = registeredPaths.some((path) =>
        path.every((segment, index) =>
          segment.startsWith("<") ? tokens[index] !== undefined : tokens[index] === segment));
      assert.equal(matched, true, `${group.name}: ${line}`);
    }
  }
});

test("task primary workflow exposes the complete seven-step lifecycle", () => {
  const taskWorkflow = commandGroups.find((group) => group.name === "task")?.primaryWorkflow;

  assert.deepEqual(taskWorkflow, [
    "ha task create --title \"<title>\"",
    "ha task start <task-id>",
    "ha task progress append <task-id> --text \"<update>\"",
    "ha fact record --task <task-id> --statement \"<verified fact>\"",
    "ha task submit <task-id> --from-file submission.json",
    "ha task code-doc reconcile <task-id> --commit <full-sha> [--path <repo-file-path>]...",
    "ha task complete <task-id> --approve --from-file approval.json"
  ]);
});

test("every registered leaf remains directly reachable through help", () => {
  for (const entry of commandRegistry) {
    const parsed = parseArgs([...entry.commandPath, "--help"]);
    assert.equal(parsed.ok, true, entry.kind);
    if (!parsed.ok) continue;
    assert.equal(parsed.value.action.kind, "help", entry.kind);
    if (parsed.value.action.kind === "help") {
      assert.equal(parsed.value.action.commandKind, entry.kind, entry.kind);
    }
  }
});
