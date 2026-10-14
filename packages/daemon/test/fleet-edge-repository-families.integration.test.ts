// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";

test(
  "settings provenance answers through the edge host after the center disconnects",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const viewRoot = path.join(f.root, "edge-view");
    await catchUpReplica({
      ...f.peer("node-one"),
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
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
        mission: "Inspect the repository",
        disabled: true,
        idempotencyKey: "edge-schedule-create",
      },
      localAuthFixture(),
    );
    assert.equal(schedule.outcome, "applied", JSON.stringify(schedule));
    // The authored settings update reaches the replica as replicated commits on the same generation,
    // not as a fresh base backup.
    const viewDir = path.join(viewRoot, "repos", "lease-repo", "views", "node-one"),
      generationBefore = readReplicaGeneration(viewDir)!.id;
    await catchUpReplica({
      ...f.peer("node-one"),
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    assert.equal(readReplicaGeneration(viewDir)!.id, generationBefore, "settings update must arrive incrementally");
    const e = await fleetEdgeHostFixture(t, f, { viewRoot });
    const updatedTruth = await f.host.run("lease-repo", { kind: "settings-read" }, localAuthFixture());
    const listTruth = await f.host.run("lease-repo", { kind: "schedule-list" }, localAuthFixture());
    const showTruth = await f.host.run(
      "lease-repo",
      { kind: "schedule-show", scheduleId: "edge-schedule" },
      localAuthFixture(),
    );
    assert.equal(showTruth.outcome, "applied", JSON.stringify(showTruth));
    const runsTruth = await f.host.run(
      "lease-repo",
      { kind: "schedule-runs", scheduleId: "edge-schedule" },
      localAuthFixture(),
    );
    const reckonTruth = await f.host.run("lease-repo", { kind: "schedule-reckon" }, localAuthFixture());
    await f.center.close();
    const reckon = await e.command({ kind: "schedule-reckon" });
    assert.equal(reckon.outcome, "applied", JSON.stringify(reckon));
    assert.deepEqual(JSON.parse(String(reckon.evidence)).signals, JSON.parse(String(reckonTruth.evidence)).signals);
    assert.ok(reckon.cut, "reckoning must use the replica query with the center disconnected");
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
    const runs = await e.command({ kind: "schedule-runs", scheduleId: "edge-schedule" });
    assert.equal(runs.outcome, "applied", JSON.stringify(runs));
    assert.deepEqual(JSON.parse(String(runs.evidence)), JSON.parse(String(runsTruth.evidence)));
    assert.ok(runs.cut, "schedule history must use the replica cut with the center disconnected");
    assert.equal((await e.command({ kind: "schedule-show", scheduleId: "missing" })).code, "entity_not_found");
  },
);
