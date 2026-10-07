// harness-test-tier: integration
import { makeTaskEventReader } from "@harness-anything/kernel";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { readEdgeRuntimeRepository } from "../src/fleet-edge-runtime-read.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { fleetFixture, localAuthFixture, rawPeer } from "./fleet-runtime-recovery.fixtures.ts";
import { eventually, scheduleRuntimePorts, definition as settlementDefinition } from "./schedule-actions.fixtures.ts";
const replicaQuota = 64 * 1024 * 1024;
test("edge terminal task settlement rejects a changed node owner", { timeout: 60_000 }, async (t) => {
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
    nodeId: fixture.subject.nodeId,
    credential: "machine-secret",
    repoId: fixture.subject.repoId,
    viewRoot,
    diskQuotaBytes: replicaQuota,
  });
  applyFleetMirrorCut(viewRoot, fixture.subject.repoId, workspaceRoot, "pull");
  let terminal: (() => void) | undefined;
  const runtime = openFleetEdgeRuntime({
    request: {
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
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
    taskId: fixture.subject.taskId,
    runtimeInstanceId: settlementDefinition.instanceId,
    cwd: { scope: "repo-root" },
    prompt: "Finish this task.",
    idempotencyKey: "holder-change",
  });
  assert.equal(launched.outcome, "applied", JSON.stringify(launched));
  assert.ok(terminal);
  const events = () => makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo }).read().events;
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
  const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
  const rejected = await peer.raw({
    schema: "fleet.runtime.event/v1",
    messageId: "unknown-runtime-event",
    writerEpoch: 1,
    repoId: fixture.subject.repoId,
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
  let denied!: (error: unknown) => void;
  const denial = new Promise<unknown>((resolve) => {
    denied = resolve;
  });
  t.mock.method(console, "error", (...args: unknown[]) => {
    if (String(args[0]).includes("Pending runtime work failed")) denied(args[1]);
  });
  fixture.setOwner("replacement-owner");
  terminal();
  const outcomes = () =>
    makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
      .read()
      .events.filter(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === launched.runtimeSessionId,
      )
      .map((event) => event.payload);
  // Current node ownership is rejected by the dispatch credential before lease settlement.
  assert.equal(((await denial) as { code?: string }).code, "execution_credential_rejected");
  assert.deepEqual(outcomes(), [], "the replacement owner cannot publish the original owner's terminal outcome");
  const shown = await fixture.host.run(
    fixture.subject.repoId,
    { kind: "task-show", taskId: fixture.subject.taskId },
    localAuthFixture(),
  );
  const snapshot = JSON.parse(String(shown.evidence));
  assert.equal(snapshot.lease.actor.principal.personId, "person-owner");
  assert.deepEqual(snapshot.lease.source, { kind: "node", nodeId: fixture.subject.nodeId });
  fixture.setOwner("person-owner");
  await runtime.reconcile();
  assert.equal(await eventually(async () => outcomes().length > 0), true);
  assert.equal(outcomes()[0]?.outcome, "failed", JSON.stringify(outcomes()));
  // Ownership is rejected before archive publication. This injected process has no
  // worker-host record, so restored ownership recovers an explicit lost-session result.
  const recovered = await runtime.run("repo.agentRuntime.sessions.read", {
    runtimeSessionId: launched.runtimeSessionId,
  });
  assert.deepEqual(recovered.result, {
    ref: outcomes()[0]?.resultRef,
    text: "Runtime session lost: runtime process was never recorded before daemon restart.",
  });
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
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        diskQuotaBytes: replicaQuota,
      });
      applyFleetMirrorCut(viewRoot, fixture.subject.repoId, workspaceRoot, "pull");
      let terminal: (() => void) | undefined;
      const createRuntime = () =>
        openFleetEdgeRuntime({
          request: {
            host: "127.0.0.1",
            port: center.port,
            caPath: fixture.certFile,
            nodeId: fixture.subject.nodeId,
            credential: "machine-secret",
            repoId: fixture.subject.repoId,
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
        taskId: fixture.subject.taskId,
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
      await assert.rejects(() => runtime.reconcile());
      if (restart) {
        runtime.close();
        runtime = createRuntime();
      }
      await fixture.center(center.port);
      await runtime.reconcile();
      const outcomes = () =>
        makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
          .read()
          .events.filter(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === launched.runtimeSessionId,
          )
          .map((event) => event.payload);
      assert.equal(await eventually(async () => outcomes().length > 0), true);
      assert.equal(outcomes().length, 1, "recovery publishes one canonical terminal outcome");
      await runtime.reconcile();
      runtime.close();
      runtime = createRuntime();
      await runtime.reconcile();
      readEdgeRuntimeRepository(
        {
          viewRoot,
          workspaceRoot,
          repoId: fixture.subject.repoId,
          nodeId: fixture.subject.nodeId,
          principalId: "person-owner",
        },
        "repo.agentRuntime.overview",
        { limit: 1 },
      );
      assert.equal(outcomes().length, 1, "later reads and restart must not duplicate the terminal event");
      const released = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
        .read()
        .events.filter((event) => event.type === "lease_released" && event.taskId === fixture.subject.taskId);
      assert.equal(released.length, 1, "the matching execution lease is released once");
    },
  );
