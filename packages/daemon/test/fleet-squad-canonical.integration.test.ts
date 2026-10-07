// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient, runFleetRuntimeEventClient } from "../src/fleet/edge.ts";

test("owner edge Squad launch publishes a canonical run visible on another edge", { timeout: 180_000 }, async (t) => {
  const witness = {
    installationId: "squad-install",
    kindId: "codex",
    executablePath: "/usr/bin/true",
    version: "fixture",
    observedAt: new Date().toISOString(),
  };
  const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
    runtimeDiscover: () => [witness],
    runtimeLaunch: () => {
      throw new Error("Center must not launch Squad processes");
    },
  });
  await f.host.runtimeInstance(
    "daemon.runtimeInstance.create",
    {
      instanceId: "center-codex",
      name: "Center declaration witness",
      kindId: "codex",
      installationId: "squad-install",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    },
    localAuthFixture(),
  );
  for (const id of ["squad-leader", "squad-worker"]) {
    const receipt = await f.host.run(
      "lease-repo",
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id,
          name: id,
          instructions: "Perform the bounded Squad assignment.",
          runtimes: [{ type: "codex" }],
        },
      },
      localAuthFixture(),
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  }
  const installed = await f.host.run(
    "lease-repo",
    {
      kind: "squad-install",
      declaration: {
        schema: "squad-declaration/v1",
        id: "canonical-squad",
        name: "Canonical Squad",
        leader: "squad-leader",
        workers: ["squad-worker"],
        leaderTurnBudget: 4,
        roster: "# Squad\n\nCoordinate the workers and publish the synthesis at artifacts/reports/{squadRunId}.md.",
      },
    },
    localAuthFixture(),
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  const created = await f.command("node-one", { kind: "task-create", title: "Canonical Squad run" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const taskId = String(created.receipt!.taskId);
  let launches = 0;
  const a = await fleetEdgeHostFixture(t, f, {
    name: "owner",
    runtimeDiscover: () => [
      {
        installationId: "squad-install",
        kindId: "codex",
        executablePath: "/usr/bin/true",
        version: "fixture",
        observedAt: new Date().toISOString(),
      },
    ],
    runtimeLaunch: () => {
      launches += 1;
      return {
        pid: 90210,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      };
    },
  });
  const b = await fleetEdgeHostFixture(t, f, { name: "reader", nodeId: "node-two" });
  const instance = await a.host.runtimeInstance(
    "daemon.runtimeInstance.create",
    {
      instanceId: "squad-runtime",
      name: "Squad runtime",
      kindId: "codex",
      installationId: "squad-install",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    },
    localAuthFixture(),
  );
  assert.equal(instance.outcome, "applied", JSON.stringify(instance));
  const { schema: _schema, ...configuration } = a.config;
  const started = await a.host.fleet.edgeRuntime(
    {
      ...configuration,
      workspaceRoot: a.edgeRoot,
      method: "repo.squad.control",
      action: {
        kind: "squad-run",
        squadId: "canonical-squad",
        taskId,
        runtimeInstanceId: "squad-runtime",
        cwd: { scope: "repo-root" },
      },
    },
    localAuthFixture(),
  );
  assert.equal(started.outcome, "completed", JSON.stringify(started));
  assert.equal(launches, 1);
  const runId = String(started.squadRunId);
  const canonical = makeTaskEventReader({ repoId: "lease-repo", rootDir: f.repo }).read().events;
  const observed = canonical
    .filter((event) => event.schema === "agent-runtime-event/v1" && event.type === "runtime_squad_run_observed")
    .at(-1)!;
  assert.ok(observed, "real coordinator emitted an accepted observation");
  assert.equal(observed.payload.squadRunId, runId);
  assert.equal(observed.source && typeof observed.source === "object" ? observed.source.nodeId : null, "node-one");
  assert.equal(JSON.stringify(observed).includes(a.edgeRoot), false, "no machine path in public observation");
  await f.host.replica("lease-repo").waitForCut(f.eventCount());
  await runFleetReplicaPullClient({ ...f.peer("node-two"), viewRoot: b.viewRoot, diskQuotaBytes: b.config.quotaBytes });
  const beforeReplay = f.eventCount();
  const replay = await runFleetRuntimeEventClient({
    ...f.peer("node-one"),
    eventType: observed.type,
    opId: observed.opId,
    payload: observed.payload,
  });
  assert.equal(replay.receipt.replayed, true);
  assert.equal(f.eventCount(), beforeReplay);
  await assert.rejects(
    runFleetRuntimeEventClient({
      ...f.peer("node-two"),
      eventType: observed.type,
      opId: observed.opId,
      payload: observed.payload,
    }),
    /owner|source|scope/iu,
  );
  await f.center.close();
  const answer = await b.command({ kind: "squad-status", squadRunId: runId });
  assert.equal(answer.outcome, "applied", JSON.stringify(answer));
  assert.equal(answer.squadRunId, runId);
  assert.equal(answer.status, "leader_running");
  assert.ok(answer.cut);
  assert.equal(launches, 1);
  t.diagnostic(`A launch -> canonical observation ${observed.workspaceRevision} -> B offline status ${runId}`);
});
