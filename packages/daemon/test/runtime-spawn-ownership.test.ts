// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { ownedByRuntimeSpawner } from "../src/runtime-spawn-adoption.ts";
import type { RuntimeBinding } from "../src/runtime-spawn-types.ts";

const owner = { nodeId: "node-one" };
const binding = (source: RuntimeBinding["source"]): RuntimeBinding => ({
  actor: { principal: { personId: "owner" } },
  source,
});
test("edge spawner owns exactly its authenticated node", () => {
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner }), owner), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner, nodeId: "node-two" }), owner), false);
  assert.equal(ownedByRuntimeSpawner(binding("local"), owner), false);
});
test("local spawner retains local and node restart adoption", () => {
  assert.equal(ownedByRuntimeSpawner(binding("local"), undefined), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner }), undefined), true);
});
