// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { commandRegistry } from "../src/cli/command-registry.ts";
import { parseArgs } from "../src/cli/parse-args.ts";

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
