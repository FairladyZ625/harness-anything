// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { dispatchStreamPath } from "../src/dispatch-stream.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { fleetFixture, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { catchUpReplica, startResidentReplicaSync } from "./replica-catch-up.fixture.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

test(
  "a center owner ruling durably closes an unreachable edge attempt without claiming a physical stop",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
    const center = await fixture.center(),
      workspaceRoot = path.join(fixture.root, "unreachable-edge"),
      viewRoot = path.join(fixture.root, "unreachable-view"),
      quotaBytes = 64 * 1024 * 1024;
    mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: unreachable-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const connection = {
      readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: quotaBytes,
    };
    await catchUpReplica(connection);
    const resident = startResidentReplicaSync({ ...connection, hostname: "127.0.0.1" });
    fixture.track(resident.close);
    applyFleetMirrorCut(viewRoot, fixture.subject.repoId, workspaceRoot, "pull");
    const runtime = openFleetEdgeRuntime({
      readBinding: () => fixture.owners.binding(fixture.subject.nodeId),
      readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
      controlBinding: () => fixture.owners.binding(fixture.subject.nodeId),
      resolveLocation: () => ({
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes,
        workspaceRoot,
        method: "repo.agentRuntime.spawn",
        action: {},
      }),
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(fixture.root, "unreachable-edge-user"),
        daemonId: "unreachable-edge",
        endpoint: path.join(fixture.root, "unreachable-edge.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: () => ({
        pid: 2_147_483_647,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    fixture.track(() => runtime.close());
    const launched = await runtime.run("repo.agentRuntime.spawn", {
      taskId: fixture.subject.taskId,
      runtimeInstanceId: definition.instanceId,
      cwd: { scope: "repo-root" },
      prompt: "Remain on the unreachable edge.",
      dispatchKey: "center-owner-ruling",
    });
    assert.equal(launched.outcome, "applied", JSON.stringify(launched));
    const runtimeSessionId = String(launched.runtimeSessionId),
      dispatchId = String(launched.dispatchId),
      owner = localAuthFixture();
    runtime.close();
    assert.equal(existsSync(dispatchStreamPath(fixture.repo, dispatchId)), false);
    const unprovenBody = "An observation without physical stop proof is not an owner ruling.",
      unprovenSha = sha256Text(unprovenBody),
      unproven = await fixture.host.runtimeIngress(
        fixture.subject.repoId,
        {
          kind: "event",
          type: "runtime_session_outcome_observed",
          opId: "ordinary-unproven-outcome",
          payload: {
            runtimeSessionId,
            dispatchId,
            outcome: "unknown",
            exitCode: null,
            resultRef: `artifact:runtime-result/sha256/${unprovenSha}`,
            result: {
              sha256: unprovenSha,
              size: Buffer.byteLength(unprovenBody),
              mediaType: "text/plain; charset=utf-8",
            },
          },
          resultBody: unprovenBody,
        },
        fixture.owners.auth(fixture.subject),
      );
    assert.equal(unproven.outcome, "op_rejected", JSON.stringify(unproven));
    assert.equal(unproven.code, "runtime_process_group_unproven", JSON.stringify(unproven));
    const receipt = await fixture.host.cancelRuntime(
      fixture.subject.repoId,
      { runtimeSessionId, ruling: "The edge is unreachable; explicitly abandon this attempt." },
      owner,
    );
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.detail, "ruling_resolved");
    const lifecycle = await fixture.host.readDispatchLifecycle(
      fixture.subject.repoId,
      { by: "session", runtimeSessionId },
      owner,
    );
    assert.equal(lifecycle.status, "ready");
    if (lifecycle.status !== "ready") assert.fail("canonical lifecycle must be available");
    assert.equal(lifecycle.rows[0]?.groupPhase, "closed");
    assert.equal(lifecycle.rows[0]?.attempt.stopProof, "unproven");
    assert.equal(lifecycle.rows[0]?.policy.groupSettled, true);
    const repeated = await fixture.host.cancelRuntime(
      fixture.subject.repoId,
      { runtimeSessionId, ruling: "The same owner retries the explicit abandonment." },
      owner,
    );
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.detail, "already-exited");
    const events = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo }).read().events,
      outcome = events.find(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      ).length,
      1,
    );
    assert.ok(outcome?.type === "runtime_session_outcome_observed");
    assert.equal(outcome.payload.reasonCode, "ruling_resolved");
    assert.equal(outcome.actor.principal.personId, "person-owner");
    assert.equal(outcome.actor.executor, null);
    assert.deepEqual(outcome.source, { kind: "node", nodeId: fixture.subject.nodeId });
    assert.equal(
      events.filter((event) => event.type === "lease_released" && event.taskId === fixture.subject.taskId).length,
      1,
    );
  },
);
