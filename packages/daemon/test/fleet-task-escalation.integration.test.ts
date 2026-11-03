// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { readRuntimeExecutionPrincipal } from "../src/runtime-execution-principal-store.ts";
import { fleetFixture, initRepo, localAuthFixture, git } from "./fleet-runtime-recovery.fixtures.ts";

const replicaQuota = 64 * 1024 * 1024;

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
        baseUrl: null,
        authMode: "subscription",
      },
      runtimeInstallation: RuntimeInstallationWitness = {
        installationId: runtimeDefinition.installationId,
        kindId: runtimeDefinition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      launchedInstances: string[] = [];
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
    writeFileSync(
      path.join(edgeRoot, "fleet-edge.json"),
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: fixture.subject.repoId,
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        viewRoot,
        quotaBytes: replicaQuota,
      }),
    );
    fixture.owners.signIn(edgeUserRoot, fixture.subject.nodeId, edgeRoot);
    registerBootstrappedDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.subject.repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });

    const edgeHost = await openDaemonHost({
      daemonId: "fleet-escalation-edge",
      userRoot: edgeUserRoot,
      runtimeDiscover: () => [runtimeInstallation],
      runtimeLaunch: (prepared) => {
        if (!prepared.prompt.includes("Unbound fleet session")) {
          launchedInstances.push(prepared.definition.instanceId);
          launchedCredential = prepared.env.HARNESS_EXECUTION_CREDENTIAL ?? null;
        }
        return {
          pid: 91234,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    t.after(() => edgeHost.close());
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
        edgeExecutionPrincipal: async (candidate) => {
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
          method: "daemon.fleet.task.run",
          params: {
            payload: {
              host: "127.0.0.1",
              port: center.port,
              caPath: fixture.certFile,
              nodeId: fixture.subject.nodeId,
              credential: "machine-secret",
              repoId: fixture.subject.repoId,
              viewRoot,
              quotaBytes: replicaQuota,
              workspaceRoot: edgeRoot,
              action: taskAction,
            },
          },
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
  },
);
