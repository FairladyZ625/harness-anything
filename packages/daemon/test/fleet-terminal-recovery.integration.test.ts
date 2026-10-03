// harness-test-tier: integration
import { makeTaskEventReader } from "@harness-anything/kernel";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { fleetFixture, rawPeer } from "./fleet-runtime-recovery.fixtures.ts";
import { eventually, scheduleRuntimePorts, definition as settlementDefinition } from "./schedule-actions.fixtures.ts";
const replicaQuota = 64 * 1024 * 1024;
test("edge terminal task settlement rejects a changed assignment holder", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    workspaceRoot = path.join(fixture.root, "settlement-edge"),
    viewRoot = path.join(fixture.root, "settlement-view");
  mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: settlement-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  await runFleetReplicaPullClient({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.assignment.nodeId,
    credential: "machine-secret",
    assignmentId: fixture.assignment.assignmentId,
    viewRoot,
    diskQuotaBytes: replicaQuota,
  });
  applyFleetMirrorCut(viewRoot, fixture.assignment.repoId, workspaceRoot, "pull");
  let terminal: (() => void) | undefined;
  const runtime = openFleetEdgeRuntime({
    request: {
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      repoId: fixture.assignment.repoId,
      viewRoot,
      quotaBytes: replicaQuota,
      workspaceRoot,
      method: "repo.agentRuntime.spawn",
      action: {},
    },
    daemonGeneration: 1,
    daemonRoute: {
      userRoot: path.join(fixture.root, "settlement-user"),
      daemonId: "settlement-edge",
      endpoint: path.join(fixture.root, "settlement.sock"),
    },
    ports: scheduleRuntimePorts(),
    launch: () => {
      let output: ((chunk: string) => void) | undefined;
      return {
        pid: 81234,
        onOutput: (listener) => {
          output = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          terminal = () => {
            output?.(`${JSON.stringify({ type: "turn.completed" })}\n`);
            listener(0);
          };
        },
        terminate: () => undefined,
      };
    },
  });
  fixture.track(() => runtime.close());
  const launched = await runtime.run("repo.agentRuntime.spawn", {
    taskId: fixture.assignment.taskId,
    runtimeInstanceId: settlementDefinition.instanceId,
    cwd: { scope: "repo-root" },
    prompt: "Finish this task.",
    idempotencyKey: "holder-change",
  });
  assert.equal(launched.outcome, "applied", JSON.stringify(launched));
  assert.ok(terminal);
  const events = () => makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo }).read().events;
  assert.equal(
    await eventually(async () =>
      events().some(
        (event) =>
          event.type === "runtime_session_liveness_changed" &&
          event.payload.runtimeSessionId === launched.runtimeSessionId,
      ),
    ),
    true,
    "the real edge producer must publish process liveness through Fleet into the center journal",
  );
  const live = events().find(
    (event) =>
      event.type === "runtime_session_liveness_changed" && event.payload.runtimeSessionId === launched.runtimeSessionId,
  );
  assert.equal(live?.payload.liveness, "live");
  const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret");
  const rejected = await peer.raw({
    schema: "fleet.runtime.event/v1",
    messageId: "unknown-runtime-event",
    assignmentId: fixture.assignment.assignmentId,
    writerEpoch: 1,
    repoId: fixture.assignment.repoId,
    opId: "unknown-runtime-event",
    eventType: "runtime_session_unknown_event",
    payload: { runtimeSessionId: launched.runtimeSessionId, liveness: "live" },
    result: null,
    dispatchContext: null,
  });
  assert.equal(rejected.schema, "fleet.error/v1");
  if (rejected.schema !== "fleet.error/v1") assert.fail("expected a Fleet error");
  assert.equal(rejected.code, "invalid_frame");
  assert.equal(
    events().some((event) => event.opId === "unknown-runtime-event"),
    false,
  );
  peer.close();
  // The node moves to another owner mid-run: the lease its previous owner holds is not the new owner's to release.
  fixture.setOwner("replacement-owner");
  terminal();
  const outcomes = () =>
    makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
      .read()
      .events.filter(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === launched.runtimeSessionId,
      )
      .map((event) => event.payload);
  assert.equal(await eventually(async () => outcomes().length > 0), true);
  assert.equal(outcomes()[0]?.reasonCode, "runtime_lease_release_failed", JSON.stringify(outcomes()));
  assert.equal(outcomes()[0]?.outcome, "failed", JSON.stringify(outcomes()));
});
for (const restart of [false, true])
  test(
    `edge terminal outcome recovers after center disconnect (restart=${restart})`,
    { timeout: 60_000 },
    async (t) => {
      const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
      t.after(() => fixture.close());
      const center = await fixture.center(),
        workspaceRoot = path.join(fixture.root, "settlement-edge"),
        viewRoot = path.join(fixture.root, "settlement-view");
      mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
      writeFileSync(
        path.join(workspaceRoot, "harness/harness.yaml"),
        "schema: harness-anything/v1\nname: settlement-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      await runFleetReplicaPullClient({
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.assignment.nodeId,
        credential: "machine-secret",
        assignmentId: fixture.assignment.assignmentId,
        viewRoot,
        diskQuotaBytes: replicaQuota,
      });
      applyFleetMirrorCut(viewRoot, fixture.assignment.repoId, workspaceRoot, "pull");
      let terminal: (() => void) | undefined;
      const createRuntime = () =>
        openFleetEdgeRuntime({
          request: {
            host: "127.0.0.1",
            port: center.port,
            caPath: fixture.certFile,
            nodeId: fixture.assignment.nodeId,
            credential: "machine-secret",
            assignmentId: fixture.assignment.assignmentId,
            repoId: fixture.assignment.repoId,
            viewRoot,
            quotaBytes: replicaQuota,
            workspaceRoot,
            method: "repo.agentRuntime.spawn",
            action: {},
          },
          daemonGeneration: 1,
          daemonRoute: {
            userRoot: path.join(fixture.root, "settlement-user"),
            daemonId: "settlement-edge",
            endpoint: path.join(fixture.root, "settlement.sock"),
          },
          ports: scheduleRuntimePorts(),
          launch: () => {
            let output: ((chunk: string) => void) | undefined;
            return {
              pid: 81234,
              onOutput: (listener) => {
                output = listener;
              },
              onErrorOutput: () => undefined,
              onExit: (listener) => {
                terminal = () => {
                  output?.(`${JSON.stringify({ type: "turn.completed" })}\n`);
                  listener(0);
                };
              },
              terminate: () => undefined,
            };
          },
        });
      let runtime = createRuntime();
      fixture.track(() => runtime.close());
      const launched = await runtime.run("repo.agentRuntime.spawn", {
        taskId: fixture.assignment.taskId,
        runtimeInstanceId: settlementDefinition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Finish this task.",
        idempotencyKey: "holder-change",
      });
      assert.equal(launched.outcome, "applied", JSON.stringify(launched));
      assert.ok(terminal);
      let archiveFailed!: () => void;
      const archiveFailure = new Promise<void>((resolve) => {
        archiveFailed = resolve;
      });
      t.mock.method(console, "error", (...args: unknown[]) => {
        if (String(args[0]).includes("[runtime-archive]")) archiveFailed();
      });
      await center.close();
      terminal();
      await archiveFailure;
      await assert.rejects(() => runtime.run("repo.agentRuntime.overview", { limit: 1 }));
      if (restart) {
        runtime.close();
        runtime = createRuntime();
      }
      await fixture.center(center.port);
      await runtime.run("repo.agentRuntime.overview", { limit: 1 });
      const outcomes = () =>
        makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
          .read()
          .events.filter(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === launched.runtimeSessionId,
          )
          .map((event) => event.payload);
      assert.equal(await eventually(async () => outcomes().length > 0), true);
      assert.equal(outcomes().length, 1, "recovery publishes one canonical terminal outcome");
      await runtime.run("repo.agentRuntime.overview", { limit: 1 });
      runtime.close();
      runtime = createRuntime();
      await runtime.run("repo.agentRuntime.overview", { limit: 1 });
      assert.equal(outcomes().length, 1, "later reads and restart must not duplicate the terminal event");
      const released = makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
        .read()
        .events.filter((event) => event.type === "lease_released" && event.taskId === fixture.assignment.taskId);
      assert.equal(released.length, 1, "the matching execution lease is released once");
    },
  );
