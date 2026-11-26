// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { applyFleetMirrorCut } from "../src/daemon-host/fleet-edge-mirror.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { readRuntimeExecutionPrincipal } from "../src/daemon-host/runtime-execution-principal-store.ts";
import { fleetFixture, initRepo, localAuthFixture, git } from "./fleet-runtime-recovery.fixtures.ts";
import { recordStoppedFixtureContainment } from "./fixtures/runtime-process.ts";

const replicaQuota = 64 * 1024 * 1024;

function fixtureProbeExecutable(rootDir: string): string {
  if (process.platform !== "win32") return "/usr/bin/true";
  const binDir = path.join(rootDir, "fixture-bin");
  mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "codex-probe-ok.cmd");
  writeFileSync(stub, "@exit /b 0\r\n", "utf8");
  return stub;
}

test(
  "an edge worker escalation reaches its runtime owner and blocks without redispatch",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      edgeRoot = path.join(fixture.root, "escalation-edge"),
      edgeUserRoot = path.join(fixture.root, "escalation-edge-user"),
      viewRoot = path.join(fixture.root, "escalation-edge-view"),
      localAuth = localAuthFixture(),
      runtimeDefinition: AgentDefinitionSnapshot = {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "edge-escalation-codex",
        installationId: "edge-escalation-installation",
        kindId: "codex",
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        endpointKind: "official",
        baseUrlHash: null,
        authMode: "subscription",
      },
      runtimeInstallation: RuntimeInstallationWitness = {
        installationId: runtimeDefinition.installationId,
        kindId: runtimeDefinition.kindId,
        executablePath: fixtureProbeExecutable(fixture.root),
        version: "1.0.0",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      launchedInstances: string[] = [],
      launchedPrompts: string[] = [];
    let launchedCredential: string | null = null;
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      readFileSync(path.join(fixture.repo, "harness/harness.yaml")),
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");
    await catchUpReplica({
      readAccessToken: async () => `device-token-${fixture.subject.nodeId}`,
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    assert.equal(applyFleetMirrorCut(viewRoot, fixture.subject.repoId, edgeRoot, "pull").outcome, "applied");
    writeFleetEdgeConfig(edgeUserRoot, fixture.subject.repoId, {
      repoId: fixture.subject.repoId,
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      viewRoot,
      quotaBytes: replicaQuota,
    });
    registerBootstrappedDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.subject.repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    fixture.owners.signIn(edgeUserRoot, fixture.subject.nodeId, edgeRoot);

    const edgeHost = await openDaemonHost({
      daemonId: "fleet-escalation-edge",
      userRoot: edgeUserRoot,
      runtimeDiscover: () => [runtimeInstallation],
      runtimeLaunch: (prepared, persistence) => {
        if (!prepared.prompt.includes("Unbound fleet session")) {
          launchedInstances.push(prepared.definition.instanceId);
          launchedPrompts.push(prepared.prompt);
          launchedCredential = prepared.env.HARNESS_EXECUTION_CREDENTIAL ?? null;
        }
        recordStoppedFixtureContainment(persistence, 91234);
        return {
          pid: 91234,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    fixture.track(() => edgeHost.close());
    await edgeHost.attachmentsSettled();
    await registerFixtureRuntimeInstance(
      edgeHost,
      fixture.subject.repoId,
      localAuth,
      {
        instanceId: runtimeDefinition.instanceId,
        name: "Edge escalation worker",
        kindId: runtimeDefinition.kindId,
        installationId: runtimeDefinition.installationId,
        providerId: runtimeDefinition.providerId,
        models: [runtimeDefinition.model],
        codex: { reasoningEffort: runtimeDefinition.reasoningEffort },
        authMode: runtimeDefinition.authMode,
      },
      { allowHost: fixture.host },
    );
    await catchUpReplica({
      readAccessToken: async () => `device-token-${fixture.subject.nodeId}`,
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });

    const spawned = await edgeHost.fleet.edgeRuntime(
      {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: {
          runtimeInstanceId: runtimeDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Escalate an owner decision.",
          taskId: fixture.subject.taskId,
          dispatchKey: "edge-task-escalation",
        },
      },
      localAuth,
    );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const credential = launchedCredential ?? String(spawned.executionCredential ?? "");
    assert.ok(credential, "edge dispatch must receive a scoped execution credential");
    assert.equal(launchedInstances.length, 1);

    const question = "May this edge worker change the shared fleet transport?",
      action = {
        kind: "task-escalate",
        taskId: fixture.subject.taskId,
        question,
        options: ["Keep the boundary", "Ask the owner to change it"],
        recommendation: "Keep the boundary",
        reason: "The shared transport is outside this worker task.",
      };
    const invokeWorkerCommand = async (executionCredential: string | undefined, taskAction: typeof action) => {
      const rpc = createJsonRpcProtocolServer({
        host: edgeHost,
        build: { commit: null },
        authContext: localAuth,
        executionPrincipal: async (candidate) => {
          const principal = readRuntimeExecutionPrincipal(edgeRoot, candidate);
          if (!principal)
            throw Object.assign(new Error("Execution credential is unavailable."), {
              code: "execution_credential_rejected",
            });
          return principal;
        },
        sessionPrincipal: (method, params) => edgeHost.sessionPrincipal(localAuth, method, params),
        emit: async () => undefined,
      });
      try {
        await rpc.handle({
          jsonrpc: "2.0",
          id: 0,
          method: "protocol.hello",
          params: {
            protocolVersion: currentDaemonProtocolVersion,
            ...(executionCredential ? { executionCredential } : {}),
          },
        });
        const response = await rpc.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "repo.task.run",
          params: { repo: { repoId: fixture.subject.repoId }, payload: { action: taskAction } },
        });
        assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
        return response.result as Record<string, unknown>;
      } finally {
        rpc.close();
      }
    };

    const noCredential = await invokeWorkerCommand(undefined, action),
      crossTask = await invokeWorkerCommand(credential, { ...action, taskId: "task-outside-dispatch" });
    assert.equal(noCredential.outcome, "op_rejected", JSON.stringify(noCredential));
    assert.equal(noCredential.code, "execution_credential_rejected", JSON.stringify(noCredential));
    assert.equal(crossTask.outcome, "op_rejected", JSON.stringify(crossTask));
    assert.equal(crossTask.code, "execution_credential_rejected", JSON.stringify(crossTask));

    const escalated = await invokeWorkerCommand(credential, action);
    assert.equal(escalated.outcome, "applied", JSON.stringify(escalated));
    assert.deepEqual(
      {
        outcome: (escalated.edgeCancellation as Record<string, unknown> | undefined)?.outcome,
        detail: (escalated.edgeCancellation as Record<string, unknown> | undefined)?.detail,
      },
      { outcome: "pending", detail: "requested" },
      JSON.stringify(escalated),
    );

    const runtimeSessionId = String(spawned.runtimeSessionId),
      settled = await fixture.host.awaitRuntimeSessions(
        fixture.subject.repoId,
        { runtimeSessionIds: [runtimeSessionId], mode: "any" },
        fixture.auth,
      ),
      tasks = await fixture.host.read(fixture.subject.repoId, "repo.tasks.list", {}, fixture.auth),
      taskStatus = tasks.rows.find((row) => row.taskId === fixture.subject.taskId)?.snapshot.task?.status;
    assert.equal(settled.outcome, "stopped", JSON.stringify(settled));
    assert.equal(taskStatus, "blocked");
    const dispatchRead = await fixture.host.read(
      fixture.subject.repoId,
      "repo.task.dispatches",
      { taskIds: [fixture.subject.taskId] },
      fixture.auth,
    );
    assert.equal(dispatchRead.dispatches.length, 1, "escalation must stop before automatic redispatch");
    assert.equal(dispatchRead.dispatches[0]?.classification, "awaiting_ruling", JSON.stringify(dispatchRead));
    assert.equal(launchedInstances.length, 1, "the blocked task must not launch another edge runtime");
    assert.deepEqual(dispatchRead.dispatches[0]?.ruling, {
      question,
      options: ["Keep the boundary", "Ask the owner to change it"],
      path: `tasks/task-fleet-fleet/artifacts/rulings/${String(spawned.dispatchId)}.md`,
    });
    // A failed resolution document write must leave the task awaiting its owner.
    const refused = await fixture.host.run(
      fixture.subject.repoId,
      {
        kind: "task-escalation-resolve",
        taskId: fixture.subject.taskId,
        dispatchId: String(spawned.dispatchId),
        answer: "Keep the boundary.",
      },
      fixture.auth,
    );
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.code, "task_docs_require_task_command", JSON.stringify(refused));
    const afterRefusal = await fixture.host.read(
      fixture.subject.repoId,
      "repo.tasks.runtimeContext.read",
      { taskId: fixture.subject.taskId },
      fixture.auth,
    );
    assert.equal(afterRefusal.snapshot.task?.status, "blocked");
    assert.equal(afterRefusal.escalationContext, null);

    // Pin the edge's materialization policy before the answer exists so a background pull
    // can advance its replica cut without exposing the resolution on disk.
    const materialization = await edgeHost.run(
      fixture.subject.repoId,
      { kind: "settings-update", taskMaterializationPolicy: "none" },
      localAuthFixture(),
    );
    assert.equal(materialization.outcome, "applied", JSON.stringify(materialization));

    // The worker RPC mutates its connection auth; the CEO uses a fresh local session.
    const resolved = await fixture.host.run(
      fixture.subject.repoId,
      {
        kind: "task-escalation-resolve",
        taskId: fixture.subject.taskId,
        dispatchId: String(spawned.dispatchId),
        answer: "Keep the boundary.",
      },
      localAuthFixture(),
    );
    assert.equal(resolved.outcome, "applied", JSON.stringify(resolved));
    const served = await fixture.host.read(
      fixture.subject.repoId,
      "repo.tasks.runtimeContext.read",
      { taskId: fixture.subject.taskId },
      fixture.auth,
    );
    assert.ok(
      served.escalationContext?.includes("Keep the boundary."),
      JSON.stringify({ context: served.escalationContext }),
    );
    const after = await fixture.host.read(
      fixture.subject.repoId,
      "repo.task.dispatches",
      { taskIds: [fixture.subject.taskId] },
      fixture.auth,
    );
    assert.equal(after.dispatches.length, 1, "answering must not create an ownerless dispatch");
    const rulingPath = path.join(
      edgeRoot,
      "harness/tasks/task-fleet-fleet/artifacts/rulings",
      `${String(spawned.dispatchId)}.resolution.md`,
    );
    assert.equal(existsSync(rulingPath), false, "the center answer has not materialized on the edge filesystem");
    const fresh = await edgeHost.fleet.edgeRuntime(
      {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: {
          runtimeInstanceId: runtimeDefinition.instanceId,
          cwd: { scope: "repo-root" },
          taskId: fixture.subject.taskId,
          dispatchKey: "immediately-after-owner-resolution",
        },
      },
      localAuthFixture(),
    );
    assert.equal(fresh.outcome, "applied", JSON.stringify(fresh));
    const prompt = launchedPrompts.at(-1)!;
    assert.ok(prompt.includes(question));
    assert.ok(prompt.includes("Keep the boundary."));
    assert.ok(prompt.includes("Answered by:"));
    assert.ok(prompt.includes("Answered at:"));
    assert.equal(prompt.split("Owner answer to worker escalation").length - 1, 1);
  },
);
