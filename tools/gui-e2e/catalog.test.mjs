// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../gui-e2e.mjs";
import { catalog, selectScenarios, SMOKE_SCENARIO_IDS } from "./catalog.mjs";

test("SMOKE_SCENARIO_IDS defines 5 to 8 deterministic read-only core scenarios", () => {
  assert.ok(
    SMOKE_SCENARIO_IDS.length >= 5 && SMOKE_SCENARIO_IDS.length <= 8,
    `expected 5-8 smoke scenarios, got ${SMOKE_SCENARIO_IDS.length}`,
  );
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  for (const id of SMOKE_SCENARIO_IDS) {
    const scenario = byId.get(id);
    assert.ok(scenario, `smoke scenario ${id} missing from catalog`);
    assert.equal(scenario.readOnly, true, `smoke scenario ${id} must be readOnly`);
    assert.ok(
      scenario.lane === "isolated" || scenario.lane === "both",
      `smoke scenario ${id} must run in isolated lane`,
    );
  }
  const selected = selectScenarios({ lane: "isolated", smoke: true });
  assert.deepEqual(selected.map((entry) => entry.id).sort(), [...SMOKE_SCENARIO_IDS].sort());
});

test("smoke mode rejects unsupported lanes or scenario overrides", () => {
  assert.throws(() => selectScenarios({ lane: "canonical", smoke: true }), /only supports the isolated lane/u);
  assert.throws(() => selectScenarios({ lane: "all", smoke: true }), /only supports the isolated lane/u);
  assert.throws(
    () => selectScenarios({ lane: "isolated", ids: ["shell-navigation"], smoke: true }),
    /cannot be combined with --scenario/u,
  );
  assert.throws(() => parseArgs(["--smoke", "--lane", "canonical"]), /only supports --lane isolated/u);
  assert.throws(() => parseArgs(["--smoke", "--lane", "all"]), /only supports --lane isolated/u);
  assert.throws(() => parseArgs(["--smoke", "--scenario", "shell-navigation"]), /cannot be combined with --scenario/u);
  assert.equal(parseArgs(["--smoke"]).lane, "isolated");
  assert.equal(parseArgs(["--smoke", "--lane", "isolated"]).lane, "isolated");
});
