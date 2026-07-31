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
