// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";

test(
  "settings provenance answers through the edge host after the center disconnects",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const e = await fleetEdgeHostFixture(t, f);
    const replica = f.host.replica("lease-repo");
    replica.activate();
    await replica.waitForCut(f.eventCount());
    await runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    const truth = await f.host.run("lease-repo", { kind: "settings-read" }, localAuthFixture());
    assert.equal(truth.outcome, "applied", JSON.stringify(truth));
    const updated = await f.host.run(
      "lease-repo",
      {
        kind: "settings-update",
        defaultProfile: "lightweight",
        expectedVersion: Number(truth.revision),
        idempotencyKey: "edge-settings-update",
      },
      localAuthFixture(),
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    const schedule = await f.host.run(
      "lease-repo",
      {
        kind: "schedule-create",
        scheduleId: "edge-schedule",
        name: "Edge schedule",
        mode: "detect",
        everyMs: 300_000,
        agentId: "test-agent",
        runtimeInstanceId: "test-instance",
        mission: "Inspect the repository",
        disabled: true,
        idempotencyKey: "edge-schedule-create",
      },
      localAuthFixture(),
    );
    assert.equal(schedule.outcome, "applied", JSON.stringify(schedule));
    await replica.waitForCut(f.eventCount());
    const frames: string[] = [];
    await runFleetReplicaPullClient({
      ...f.peer("node-one"),
      viewRoot: e.viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
      onFrame: (frame) => {
        frames.push(frame.schema);
      },
    });
    assert.ok(frames.includes("fleet.delta.begin/v1"), "authored settings update must arrive by delta");
    const updatedTruth = await f.host.run("lease-repo", { kind: "settings-read" }, localAuthFixture());
    const listTruth = await f.host.run("lease-repo", { kind: "schedule-list" }, localAuthFixture());
    const showTruth = await f.host.run(
      "lease-repo",
      { kind: "schedule-show", scheduleId: "edge-schedule" },
      localAuthFixture(),
    );
    assert.equal(showTruth.outcome, "applied", JSON.stringify(showTruth));
    await f.center.close();
    const local = await e.command({ kind: "settings-read" });
    assert.equal(local.outcome, "applied", JSON.stringify(local));
    assert.deepEqual(JSON.parse(String(local.evidence)), JSON.parse(String(updatedTruth.evidence)));
    assert.deepEqual(local.lastChanged, updatedTruth.lastChanged);
    assert.ok(local.lastChanged, "settings attribution is present");
    assert.ok(local.cut, "settings must use the replica cut");
    const list = await e.command({ kind: "schedule-list" });
    assert.equal(list.outcome, "applied", JSON.stringify(list));
    assert.deepEqual(list.schedules, listTruth.schedules);
    assert.equal((list.schedules as unknown[]).length, 1);
    const show = await e.command({ kind: "schedule-show", scheduleId: "edge-schedule" });
    assert.equal(show.outcome, "applied", JSON.stringify(show));
    assert.deepEqual(show.schedule, showTruth.schedule);
    assert.ok(show.cut);
    assert.equal((await e.command({ kind: "schedule-show", scheduleId: "missing" })).code, "entity_not_found");
  },
);
