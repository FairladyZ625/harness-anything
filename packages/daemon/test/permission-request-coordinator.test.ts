// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRequestCoordinator } from "../src/permission-request-coordinator.ts";

const resource = { kind: "entity", repoId: "repo", entityRef: "task/task-a" } as const;
test("center queue gives one concurrent approval the revision winner", async () => {
  const coordinator = new PermissionRequestCoordinator();
  coordinator.create({
    requestId: "req-race",
    requesterPersonId: "alice",
    resource,
    actions: ["task-start"],
    reason: "run",
  });
  let writes = 0;
  const settle = async () => {
    writes += 1;
    await Promise.resolve();
    return { ok: true as const };
  };
  const [first, second] = await Promise.all([
    coordinator.approve("req-race", 0, "bob", settle),
    coordinator.approve("req-race", 0, "carol", settle),
  ]);
  assert.deepEqual([first.outcome, second.outcome].sort(), ["effective", "version_conflict"]);
  assert.equal(writes, 1);
});
