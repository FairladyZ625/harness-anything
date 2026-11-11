// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { fleetFixture, rawPeer } from "./fleet-runtime-recovery.fixtures.ts";

test(
  "Fleet lifecycle admission reads the center without an edge replica and rejects malformed queries",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetFixture(t, ["tasks/task-fleet-fleet", "agents"]);
    const center = await f.center();
    const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
    const read = (payload: Record<string, unknown>) =>
      peer.request({
        schema: "fleet.operational.read/v1",
        messageId: "lifecycle-read",
        repoId: f.subject.repoId,
        method: "repo.agentRuntime.lifecycle.read",
        payload,
      });
    const result = await read({ by: "active", limit: 100 });
    assert.equal(result.schema, "fleet.operational.read.result/v1");
    if (result.schema === "fleet.operational.read.result/v1") {
      assert.equal(result.result.status, "ready");
      assert.deepEqual(result.result.rows, []);
    }
    for (const query of [
      { by: "active", limit: 101 },
      { by: "session" },
      { by: "dispatch", dispatchIds: [] },
      { by: "unknown", limit: 1 },
    ]) {
      const refused = await read(query);
      assert.equal(refused.schema, "fleet.error/v1");
      if (refused.schema === "fleet.error/v1") assert.equal(refused.code, "invalid_field");
    }
  },
);
