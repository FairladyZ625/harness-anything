// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { ownedByRuntimeSpawner } from "../src/runtime-spawn-adoption.ts";
import type { RuntimeBinding } from "../src/runtime-spawn-types.ts";

const owner = { nodeId: "node-one", assignmentId: "assignment-one" };
const binding = (source: RuntimeBinding["source"]): RuntimeBinding => ({
  actor: { principal: { personId: "owner" } },
  source,
});
test("edge spawner owns exactly its node and assignment", () => {
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "assignment", ...owner }), owner), true);
  assert.equal(
    ownedByRuntimeSpawner(binding({ kind: "assignment", ...owner, assignmentId: "assignment-two" }), owner),
    false,
  );
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "assignment", ...owner, nodeId: "node-two" }), owner), false);
  assert.equal(ownedByRuntimeSpawner(binding("local"), owner), false);
});
test("local spawner retains local and assignment restart adoption", () => {
  assert.equal(ownedByRuntimeSpawner(binding("local"), undefined), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "assignment", ...owner }), undefined), true);
});
