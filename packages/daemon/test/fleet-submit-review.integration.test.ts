// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { fleetFixture, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { catchUpReplica, startResidentReplicaSync } from "./replica-catch-up.fixture.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

test(
  "an edge worker credential submits its cut and automatically dispatches its reviewer",
  { timeout: 90_000 },
  async (t) => {
    const installation = {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-11-07T00:00:00.000Z",
      },
      f = await fleetFixture(t, ["tasks", "agents"], [installation], "local", undefined, undefined, false),
      { repoId, nodeId } = f.subject,
      taskId = "task-edge-submit-review";
    t.after(() => f.close());
    await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
      instanceId: definition.instanceId,
      name: "Edge review fixture",
      kindId: definition.kindId,
      installationId: definition.installationId,
      providerId: definition.providerId,
      models: [definition.model],
      authMode: definition.authMode,
    });
    const installed = await f.host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Independent reviewer",
          instructions: "Review the accepted cut.",
          runtimes: [{ type: "codex", model: definition.model }],
          instance: definition.instanceId,
          role: "reviewer",
        },
      },
      localAuthFixture(),
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const created = await f.host.run(
      repoId,
      { kind: "task-create", taskId, title: "Edge submit review", presetId: "docs-task" },
      f.auth,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(f.repo, packagePath, (planPath) =>
      f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    );
    const started = await f.host.run(repoId, { kind: "task-start", taskId }, f.auth);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const center = await f.center(),
      edgeRoot = path.join(f.root, "submit-edge"),
      viewRoot = path.join(f.root, "submit-view"),
      channel = {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: edgeRoot,
      },
      readAccessToken = f.owners.readAccessToken(nodeId),
      replica = {
        readAccessToken,
        port: center.port,
        ca: f.cert,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        diskQuotaBytes: channel.quotaBytes,
      };
    mkdirSync(edgeRoot);
    initRepo(edgeRoot);
    await catchUpReplica(replica);
    assert.equal(applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull").outcome, "applied");
    const sync = startResidentReplicaSync(replica);
    t.after(() => sync.close());
    let executionCredential: string | undefined;
    const runtime = openFleetEdgeRuntime({
      readBinding: () => f.owners.binding(nodeId),
      controlBinding: () => f.owners.binding(nodeId),
      request: { ...channel, method: "repo.agentRuntime.spawn", action: {} },
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(f.root, "edge-user"),
        daemonId: "edge-submit",
        endpoint: path.join(f.root, "edge.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: (prepared) => {
        executionCredential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    t.after(() => runtime.close());
    const spawned = await runtime.run("repo.agentRuntime.spawn", {
      taskId,
      runtimeInstanceId: definition.instanceId,
      cwd: { scope: "repo-root" },
      prompt: "Submit the completed task.",
      dispatchKey: "edge-submit-worker",
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    assert.ok(executionCredential);
    writeFileSync(
      path.join(edgeRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nEdge worker delivery.\n## Verification\nFleet center accepted the cut.\n",
    );
    mkdirSync(path.join(edgeRoot, "harness", packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(edgeRoot, "harness", packagePath, "artifacts", "delivery.md"), "Edge delivery evidence.\n");
    const submitted = await runFleetEdgeTask(
      { payload: { ...channel, executionCredential, action: { kind: "task-submit", taskId } } },
      readAccessToken,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const reader = makeTaskEventReader({ repoId, rootDir: f.repo });
    t.after(() => reader.close());
    const events = reader.read().events,
      accepted = events.find((event) => event.type === "execution_submitted" && event.taskId === taskId),
      review = events.find(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role === "reviewer",
      );
    assert.ok(accepted, "the center accepts the worker submission first");
    assert.ok(review, `automatic reviewer dispatch must follow edge submit: ${JSON.stringify(submitted)}`);
  },
);
