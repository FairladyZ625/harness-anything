// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runFleetRuntimeEventClient } from "../src/fleet/peer.ts";
import { definition } from "./schedule-actions.fixtures.ts";
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
      { by: "constructor", limit: 1 },
      { by: "__proto__", limit: 1 },
      { by: "active", limit: 1, unexpected: true },
    ]) {
      const refused = await read(query);
      assert.equal(refused.schema, "fleet.error/v1");
      if (refused.schema === "fleet.error/v1") assert.equal(refused.code, "invalid_field");
    }
  },
);

for (const capacity of [1, 2])
  test(
    `center lifecycle admission enforces instance capacity ${capacity} and reuses released slots`,
    { timeout: 60_000 },
    async (t) => {
      const f = await fleetFixture(t, undefined, undefined, undefined, undefined, undefined, false, {
        [definition.instanceId]: capacity,
      });
      const center = await f.center();
      const peer = {
        port: center.port,
        ca: f.cert,
        nodeId: f.subject.nodeId,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        readAccessToken: async () => `device-token-${f.subject.nodeId}`,
      };
      const dispatch = (key: string) => {
        const hash = createHash("sha256").update(`${f.subject.repoId}\0${key}`).digest("hex");
        return {
          opId: `capacity-${key}`,
          eventType: "runtime_dispatch_requested",
          dispatchContext: { role: null, taskId: null, executionId: null },
          payload: {
            dispatchId: `dispatch_${hash.slice(0, 24)}`,
            runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
            instanceId: definition.instanceId,
            installationId: definition.installationId,
            kindId: definition.kindId,
            dispatchKey: key,
            definitionSnapshotRef: "artifact:runtime-definition/capacity-test",
            definitionSnapshot: definition,
          },
        };
      };
      const first = dispatch("first");
      await runFleetRuntimeEventClient({ ...peer, ...first });
      await runFleetRuntimeEventClient({
        ...peer,
        opId: "first-started",
        eventType: "runtime_session_started",
        payload: {
          runtimeSessionId: first.payload.runtimeSessionId,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: definition.kindId,
          definitionSnapshotRef: first.payload.definitionSnapshotRef,
          launchGeneration: 1,
          attachable: true,
        },
      });
      if (capacity > 1) await runFleetRuntimeEventClient({ ...peer, ...dispatch("second") });
      const before = f.eventCount();
      await assert.rejects(runFleetRuntimeEventClient({ ...peer, ...dispatch("full") }), {
        code: "runtime_capacity_exhausted",
      });
      assert.equal(f.eventCount(), before, "full capacity must not append an independent group");
      await runFleetRuntimeEventClient({
        ...peer,
        opId: "first-cancel",
        eventType: "runtime_session_cancelled",
        payload: { runtimeSessionId: first.payload.runtimeSessionId },
      });
      await assert.rejects(runFleetRuntimeEventClient({ ...peer, ...dispatch("cancel-only") }), {
        code: "runtime_capacity_exhausted",
      });
      await runFleetRuntimeEventClient({
        ...peer,
        opId: "first-stopped",
        eventType: "runtime_session_exited",
        payload: { runtimeSessionId: first.payload.runtimeSessionId },
      });
      const race = await Promise.allSettled(
        ["race-a", "race-b"].map((key) => runFleetRuntimeEventClient({ ...peer, ...dispatch(key) })),
      );
      assert.equal(
        race.filter((r) => r.status === "fulfilled").length,
        1,
        "accepted stop frees one slot; concurrent independent groups cannot both reserve it",
      );
      const rejected = race.find((r) => r.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.equal(rejected.reason.code, "runtime_capacity_exhausted", "a reservation counts before process start");
    },
  );
