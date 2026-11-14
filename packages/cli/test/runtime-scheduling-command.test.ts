// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { readSettingsFacet, validateAgentDeclarationV1 } from "@harness-anything/kernel";

const create = [
  "runtime",
  "instance",
  "create",
  "--id",
  "agy-pro",
  "--name",
  "Pro",
  "--kind",
  "agy",
  "--provider",
  "google",
  "--model",
  "Hydrogen",
  "--auth",
  "subscription",
];
test("runtime tier is projected as a number and invalid tiers fail closed on create and update", () => {
  for (const command of [create, ["runtime", "instance", "update", "agy-pro"]]) {
    for (const tier of ["1", "2", "9"]) {
      const result = parseThinCommand([...command, "--tier", tier]);
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok) assert.equal(result.command.action.tier, Number(tier));
    }
    for (const tier of ["0", "10", "-1", "1.5", "NaN", "2e0"])
      assert.equal(parseThinCommand([...command, "--tier", tier]).ok, false, tier);
  }
});

test("Agent and repository CLI expose both scheduling strategies and reject invalid values", () => {
  for (const strategy of ["sticky", "lru"]) {
    for (const command of [
      ["agent", "update", "sol"],
      ["agent", "install", "--id", "sol"],
      ["agent", "create", "--source", "."],
    ]) {
      const result = parseThinCommand([...command, "--selection-strategy", strategy]);
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok) assert.equal(result.command.action.selectionStrategy, strategy);
    }
    const settings = parseThinCommand(["settings", "update", "--runtime-selection-strategy", strategy]);
    assert.equal(settings.ok, true, JSON.stringify(settings));
    if (settings.ok) assert.equal(settings.command.action.runtimeSelectionStrategy, strategy);
  }
  for (const strategy of ["round-robin", "LRU", "0"]) {
    assert.equal(parseThinCommand(["agent", "update", "sol", "--selection-strategy", strategy]).ok, false);
    assert.equal(parseThinCommand(["settings", "update", "--runtime-selection-strategy", strategy]).ok, false);
  }
});

test("declaration and settings writing boundaries validate strategy; omitted settings use sticky", () => {
  const agent = { schema: "agent-declaration/v1", id: "worker", name: "Worker", instructions: "Run", runtimes: [] };
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, selectionStrategy: "lru" }), []);
  assert.ok(
    validateAgentDeclarationV1({ ...agent, selectionStrategy: "random" }).some((issue) =>
      issue.includes("selectionStrategy"),
    ),
  );
  assert.equal(readSettingsFacet("").runtime.selectionStrategy, "sticky");
  assert.equal(
    readSettingsFacet("settings:\n  runtime:\n    selectionStrategy: lru\n").runtime.selectionStrategy,
    "lru",
  );
  assert.throws(
    () => readSettingsFacet("settings:\n  runtime:\n    selectionStrategy: random\n"),
    /selectionStrategy/u,
  );
});
