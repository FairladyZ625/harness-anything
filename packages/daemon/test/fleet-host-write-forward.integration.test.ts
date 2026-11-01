// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { writeFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";

test("edge repository and GUI write RPCs reach the same center command port", { timeout: 90_000 }, async (t) => {
  const installation = {
    installationId: "host-forward-codex",
    kindId: "codex" as const,
    executablePath: process.execPath,
    version: "1.0.0",
    observedAt: "2026-11-01T00:00:00.000Z",
  };
  const nodeWrites: string[] = [];
  const f = await fleetNodeClaimFixture(
    t,
    (run) =>
      async (...args) => {
        if (args[2].nodePrincipal?.nodeId === "node-one") nodeWrites.push(args[1].kind);
        return run(...args);
      },
    undefined,
    undefined,
    undefined,
    false,
    { runtimeDiscover: async () => [installation] },
  );
  await registerFixtureRuntimeInstance(f.host, "lease-repo", localAuthFixture(), {
    instanceId: installation.installationId,
    name: "Host forward Codex",
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    authMode: "subscription",
  });
  const declaration = {
    schema: "agent-declaration/v1",
    id: "host-forward-agent",
    name: "Host forward agent",
    instructions: "Implement the assigned task and record verified evidence.",
    runtimes: [{ type: "codex" }],
  };
  // Validate the declaration and runtime selection independently of the new route.
  const control = await f.host.run(
    "lease-repo",
    {
      kind: "agent-install",
      declaration: { ...declaration, id: "host-forward-control" },
      expectedVersion: 0,
    },
    localAuthFixture(),
  );
  assert.equal(control.outcome, "applied", JSON.stringify(control));
  const edge = await fleetEdgeHostFixture(t, f);
  let id = 100;
  const rpc = async (method: string, payload: Record<string, unknown>) => {
    const response = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: { repo: { repoId: "lease-repo" }, payload },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    return response.result as Record<string, unknown>;
  };
  const before = f.eventCount();
  const generic = await rpc("repo.task.run", { action: { kind: "agent-install", declaration, expectedVersion: 0 } });
  assert.equal(generic.outcome, "applied", JSON.stringify(generic));
  const gui = await rpc("repo.agent.entity.write", {
    declaration: { ...declaration, id: "gui-forward-agent" },
    expectedVersion: 0,
  });
  assert.equal(gui.outcome, "applied", JSON.stringify(gui));
  assert.equal(f.eventCount(), before + 2);
  assert.deepEqual(nodeWrites, ["agent-install", "agent-install"]);
  const beforeDenied = f.eventCount();
  const nodeRefused = await edge.host.run(
    "lease-repo",
    { kind: "agent-install", declaration },
    { transportKind: "fleet-tls", nodePrincipal: { nodeId: "node-one", personId: "person-one" } },
  );
  assert.equal(nodeRefused.code, "repo_mode_read_only", JSON.stringify(nodeRefused));
  const runtimeRefused = await edge.host.run(
    "lease-repo",
    { kind: "agent-install", declaration },
    {
      ...auth,
      executionPrincipal: {
        personId: "person-one",
        repoId: "lease-repo",
        runtimeSessionId: "runtime-unrelayed",
        dispatchId: "dispatch-unrelayed",
        taskId: "task-unrelayed",
        executionId: "exe-unrelayed",
        role: "implementation",
        source: { kind: "node", nodeId: "node-one" },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  );
  assert.equal(runtimeRefused.code, "execution_credential_rejected", JSON.stringify(runtimeRefused));
  assert.equal(f.eventCount(), beforeDenied, "node calls do not loop and runtime identity never falls back to a human");
  f.owners.keycloak.revoke("person-one", "lease-repo", ["agent-install"]);
  const denied = await rpc("repo.agent.entity.write", {
    declaration: { ...declaration, id: "denied-gui-agent" },
    expectedVersion: 0,
  });
  assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
  assert.equal(f.eventCount(), beforeDenied);
  const scheduled = await rpc("repo.schedule.create", {
    scheduleId: "gui-forward-schedule",
    name: "GUI forward schedule",
    mode: "detect",
    everyMs: 300_000,
    agentId: declaration.id,
    mission: "Check the task's recorded evidence.",
    idempotencyKey: "gui-forward-schedule",
  });
  assert.equal(scheduled.outcome, "applied", JSON.stringify(scheduled));
  const runtimeSchedule = await edge.host.run(
    "lease-repo",
    { kind: "schedule-disable", scheduleId: "gui-forward-schedule", idempotencyKey: "runtime-cannot-borrow-session" },
    { ...auth, executionCredential: "unverified-runtime-secret" },
  );
  assert.equal(runtimeSchedule.code, "execution_credential_rejected", JSON.stringify(runtimeSchedule));
  const beforeDoc = f.eventCount();
  const docWrite = await edge.host.run(
    "lease-repo",
    { kind: "doc-submit", taskId: "task-without-document-mirror" },
    localAuthFixture(),
  );
  assert.equal(docWrite.code, "repo_mode_read_only", "document writes retain their dedicated admission path");
  assert.equal(f.eventCount(), beforeDoc, "the common RPC must not write the document center");
  const unconfigured = await fleetEdgeHostFixture(t, f, { name: "unconfigured", writeEdgeConfig: false });
  const beforeUnconfigured = f.eventCount();
  const unconfiguredWrite = () =>
    unconfigured.host.run("lease-repo", { kind: "agent-install", declaration }, localAuthFixture());
  assert.equal((await unconfiguredWrite()).code, "repo_mode_read_only", "registration alone never enables forwarding");
  writeFleetEdgeConfig(unconfigured.edgeRoot, { ...unconfigured.config, repoId: "different-repository" });
  assert.equal((await unconfiguredWrite()).code, "repo_mode_read_only", "config cannot forward another namespace");
  assert.equal(f.eventCount(), beforeUnconfigured);
});
