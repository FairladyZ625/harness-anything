// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { serializeFleetAction } from "../src/daemon/fleet-payload-serializer.ts";
import { actionDeclarations } from "@harness-anything/kernel";
import type { DaemonHost } from "@harness-anything/daemon/internal/daemon-host";
import { fleetNodeClaimFixture, localAuthFixture } from "../../daemon/test/fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "../../daemon/test/fleet-edge-host.fixture.ts";
import { registerFixtureRuntimeInstance } from "../../daemon/test/repo-settings.fixture.ts";

const agent = {
  schema: "agent-declaration/v1",
  id: "forwarded-worker",
  name: "Forwarded Worker",
  instructions: "Perform the assigned task and report its verified result.",
  runtimes: [{ type: "codex" }],
};

test(
  "edge Agent and Squad writes forward declarations and retain the center revision fence",
  { timeout: 90_000 },
  async (t) => {
    const installation = {
      installationId: "forwarding-codex",
      kindId: "codex" as const,
      executablePath: process.execPath,
      version: "1.0.0",
      observedAt: "2026-11-01T00:00:00.000Z",
    };
    const forwarded: Array<Parameters<DaemonHost["run"]>[1]> = [];
    const f = await fleetNodeClaimFixture(
      t,
      (run) =>
        async (...args) => {
          if (args[1].kind === "agent-install" || args[1].kind === "squad-install") forwarded.push(args[1]);
          return run(...args);
        },
      undefined,
      undefined,
      undefined,
      false,
      {
        runtimeDiscover: async () => [installation],
      },
    );
    await registerFixtureRuntimeInstance(f.host, "lease-repo", localAuthFixture(), {
      instanceId: "forwarding-codex",
      name: "Forwarding Codex",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    // Prove the fixture accepts this declaration before testing its edge transport.
    const control = await f.host.run(
      "lease-repo",
      {
        kind: "agent-install",
        declaration: { ...agent, id: "center-control" },
        expectedVersion: 0,
      },
      localAuthFixture(),
    );
    assert.equal(control.outcome, "applied", JSON.stringify(control));
    const edge = await fleetEdgeHostFixture(t, f);
    const packageSource = path.join(edge.edgeRoot, "edge-only-package");
    mkdirSync(packageSource);
    writeFileSync(path.join(packageSource, "agent.json"), JSON.stringify(agent));
    const parsed = parseThinCommand(
      ["agent", "install", "--source", "edge-only-package", "--expected-version", "0"],
      edge.edgeRoot,
    );
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("agent install must parse");
    const action = serializeFleetAction(parsed.command);
    const response = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 100,
      method: parsed.command.method,
      params: { repo: { repoId: "lease-repo" }, payload: { action } },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    const installed = response.result as Record<string, unknown>;
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.deepEqual(forwarded.at(-1)?.declaration, agent);
    assert.equal(Object.hasOwn(forwarded.at(-1)!, "packageSource"), false);
    const beforeStale = f.eventCount();
    const stale = await edge.command({
      kind: "agent-install",
      declaration: { ...agent, name: "Stale overwrite" },
      expectedVersion: 0,
    });
    assert.equal(stale.code, "revision_conflict", JSON.stringify(stale));
    assert.equal(f.eventCount(), beforeStale, "a stale edge write appends no canonical event");
    assert.equal(f.host.status().repos.find((repo) => repo.repoId === "lease-repo")?.state, "attached");
    const invalid = await edge.command({ kind: "agent-install", declaration: { ...agent, schema: "invalid" } });
    assert.equal(
      invalid.code,
      "invalid_manifest",
      JSON.stringify({ invalid, center: f.host.status().repos, edge: edge.host.status().repos }),
    );
    const dualSource = await edge.command({ kind: "agent-install", packageSource, declaration: agent });
    assert.equal(dualSource.ok, false, JSON.stringify(dualSource));
    assert.equal(f.eventCount(), beforeStale, "center schema validation is retained");
    const squad = {
      schema: "squad-declaration/v1",
      id: "forwarded-squad",
      name: "Forwarded Squad",
      leader: "center-control",
      workers: [agent.id],
      leaderTurnBudget: 4,
      roster: "# Forwarded Squad\n\nThe leader coordinates its worker and records task evidence.",
    };
    const squadFile = path.join(edge.edgeRoot, "squad.json");
    writeFileSync(squadFile, JSON.stringify(squad));
    const squadInstalled = await edge.command({ kind: "squad-install", packageSource: squadFile, expectedVersion: 0 });
    assert.equal(squadInstalled.outcome, "applied", JSON.stringify(squadInstalled));
    for (const action of [
      { kind: "squad-install", declaration: { ...squad, name: "Stale squad" }, expectedVersion: 0 },
      {
        kind: "squad-delete",
        squadId: squad.id,
        expectedVersion: squadInstalled.revision! + 1,
        reason: "Stale delete.",
      },
      { kind: "agent-delete", agentId: agent.id, expectedVersion: installed.revision! + 1, reason: "Stale delete." },
      { kind: "agent-retire", agentId: agent.id, expectedVersion: 0, reason: "Stale retirement." },
    ]) {
      const before = f.eventCount();
      const rejected = await edge.command(action);
      assert.equal(rejected.code, "revision_conflict", JSON.stringify(rejected));
      assert.equal(f.eventCount(), before);
      assert.equal(f.host.status().repos.find((repo) => repo.repoId === "lease-repo")?.state, "attached");
    }
    const squadDeleted = await edge.command({
      kind: "squad-delete",
      squadId: squad.id,
      expectedVersion: squadInstalled.revision,
      reason: "Remove test squad.",
    });
    assert.equal(squadDeleted.outcome, "applied", JSON.stringify(squadDeleted));
    const retired = await edge.command({
      kind: "agent-retire",
      agentId: agent.id,
      expectedVersion: installed.revision,
      reason: "Retire test worker.",
    });
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const inspected = await f.host.run("lease-repo", { kind: "agent-inspect", agentId: agent.id }, localAuthFixture());
    assert.equal(inspected.outcome, "applied", JSON.stringify(inspected));
    const deleted = await edge.command({
      kind: "agent-delete",
      agentId: agent.id,
      expectedVersion: JSON.parse(String(inspected.evidence)).workspaceRevision,
      reason: "Remove retired worker.",
    });
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));

    const policyPackageSource = path.join(edge.edgeRoot, "edge-policy-package");
    mkdirSync(policyPackageSource);
    const policyWorker = { ...agent, id: "edge-cli-policy-worker", name: "Edge CLI Policy Worker" };
    writeFileSync(path.join(policyPackageSource, "agent.json"), JSON.stringify(policyWorker));
    const parsedCreate = parseThinCommand(
      [
        "agent",
        "create",
        "--source",
        "edge-policy-package",
        "--scope",
        "shared",
        "--mcp-policy",
        "inherit",
        "--expected-version",
        "0",
      ],
      edge.edgeRoot,
    );
    assert.equal(parsedCreate.ok, true, JSON.stringify(parsedCreate));
    if (!parsedCreate.ok) throw new Error("agent create must parse");
    const createResponse = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 101,
      method: parsedCreate.command.method,
      params: { repo: { repoId: "lease-repo" }, payload: { action: serializeFleetAction(parsedCreate.command) } },
    });
    assert.ok(
      createResponse && !Array.isArray(createResponse) && "result" in createResponse,
      JSON.stringify(createResponse),
    );
    const createdResult = createResponse.result as Record<string, unknown>;
    assert.equal(createdResult.outcome, "applied", JSON.stringify(createdResult));
    const inspectedCreated = await f.host.run(
      "lease-repo",
      { kind: "agent-inspect", agentId: policyWorker.id },
      localAuthFixture(),
    );
    assert.equal(inspectedCreated.outcome, "applied", JSON.stringify(inspectedCreated));
    const createdEvidence = JSON.parse(String(inspectedCreated.evidence)) as {
      readonly workspaceRevision: number;
      readonly agent: { readonly mcpPolicy?: string };
    };
    assert.equal(createdEvidence.agent.mcpPolicy, "inherit");

    const parsedUpdateClear = parseThinCommand(
      [
        "agent",
        "update",
        policyWorker.id,
        "--clear-mcp-policy",
        "--expected-version",
        String(createdEvidence.workspaceRevision),
      ],
      edge.edgeRoot,
    );
    assert.equal(parsedUpdateClear.ok, true, JSON.stringify(parsedUpdateClear));
    if (!parsedUpdateClear.ok) throw new Error("agent update --clear-mcp-policy must parse");
    const updateResponse = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 102,
      method: parsedUpdateClear.command.method,
      params: {
        repo: { repoId: "lease-repo" },
        payload: { action: serializeFleetAction(parsedUpdateClear.command) },
      },
    });
    assert.ok(
      updateResponse && !Array.isArray(updateResponse) && "result" in updateResponse,
      JSON.stringify(updateResponse),
    );
    const updatedResult = updateResponse.result as Record<string, unknown>;
    assert.equal(updatedResult.outcome, "applied", JSON.stringify(updatedResult));
    const inspectedCleared = await f.host.run(
      "lease-repo",
      { kind: "agent-inspect", agentId: policyWorker.id },
      localAuthFixture(),
    );
    assert.equal(inspectedCleared.outcome, "applied", JSON.stringify(inspectedCleared));
    const clearedAgent = JSON.parse(String(inspectedCleared.evidence)).agent as Record<string, unknown>;
    assert.equal(Object.hasOwn(clearedAgent, "mcpPolicy"), false);

    const beforeDenied = f.eventCount();
    f.owners.keycloak.revoke(
      "person-one",
      "lease-repo",
      actionDeclarations.map(({ kind }) => kind),
    );
    f.owners.keycloak.permit("person-one", "lease-repo", ["repository-read"]);
    const denied = await edge.command({
      kind: "agent-install",
      declaration: { ...agent, id: "denied-worker" },
      expectedVersion: 0,
    });
    assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
    assert.equal(f.eventCount(), beforeDenied, "a reader cannot install an Agent through the edge route");
  },
);

test(
  "remote-edge local Agents stay node-local while share, unshare, and local delete cross canonical authority (F-EDGE)",
  { timeout: 90_000 },
  async (t) => {
    const installation = {
      installationId: "edge-scope-codex",
      kindId: "codex" as const,
      executablePath: process.execPath,
      version: "1.0.0",
      observedAt: "2026-11-01T00:00:00.000Z",
    };
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
      runtimeDiscover: async () => [installation],
    });
    await registerFixtureRuntimeInstance(f.host, "lease-repo", localAuthFixture(), {
      instanceId: "edge-scope-codex",
      name: "Edge Scope Codex",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    const edge = await fleetEdgeHostFixture(t, f, {
      runtimeDiscover: async () => [installation],
    });
    const edgeRuntime = await edge.host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "edge-scope-codex",
        name: "Edge Scope Codex",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        authMode: "subscription",
      },
      localAuthFixture(),
    );
    assert.equal(edgeRuntime.outcome, "applied", JSON.stringify(edgeRuntime));
    const localPkg = path.join(edge.edgeRoot, "edge-local-agent-pkg");
    mkdirSync(localPkg);
    const localAgent = {
      ...agent,
      id: "edge-private-worker",
      name: "Edge Private Worker",
    };
    writeFileSync(path.join(localPkg, "agent.json"), JSON.stringify(localAgent));

    // 1. Edge CLI `ha agent create` defaults to local scope with zero center events and center invisibility.
    const beforeCreate = f.eventCount();
    const parsedLocalCreate = parseThinCommand(
      ["agent", "create", "--source", "edge-local-agent-pkg", "--expected-version", "0"],
      edge.edgeRoot,
    );
    assert.equal(parsedLocalCreate.ok, true, JSON.stringify(parsedLocalCreate));
    if (!parsedLocalCreate.ok) throw new Error("edge local agent create must parse");
    const createResp = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 201,
      method: parsedLocalCreate.command.method,
      params: { repo: { repoId: "lease-repo" }, payload: { action: serializeFleetAction(parsedLocalCreate.command) } },
    });
    assert.ok(createResp && !Array.isArray(createResp) && "result" in createResp, JSON.stringify(createResp));
    assert.equal((createResp.result as Record<string, unknown>).outcome, "applied", JSON.stringify(createResp.result));
    assert.equal(f.eventCount(), beforeCreate, "local create on remote-edge appends zero center events");
    const centerInspectBeforeShare = await f.host.run(
      "lease-repo",
      { kind: "agent-inspect", agentId: localAgent.id },
      localAuthFixture(),
    );
    assert.equal(centerInspectBeforeShare.outcome, "op_rejected", JSON.stringify(centerInspectBeforeShare));
    const edgeLocalList = await edge.command({ kind: "agent-list", scope: "local" });
    assert.equal(edgeLocalList.outcome, "applied", JSON.stringify(edgeLocalList));
    assert.deepEqual(
      JSON.parse(String(edgeLocalList.evidence)).agents.map((row: { id: string; scope: string }) => [
        row.id,
        row.scope,
      ]),
      [[localAgent.id, "local"]],
    );

    // 2. Edge GUI declaration edit in local scope stays local with zero center events.
    const guiLocalEdit = await edge.command({
      kind: "agent-install",
      declaration: { ...localAgent, scope: "local", instructions: "Updated edge-private instructions." },
      expectedVersion: 1,
    });
    assert.equal(guiLocalEdit.outcome, "applied", JSON.stringify(guiLocalEdit));
    assert.equal(f.eventCount(), beforeCreate, "local edit on remote-edge appends zero center events");

    // 3. Edge CLI `ha agent share <id>` publishes via center canonical writer and removes local copy.
    const parsedShare = parseThinCommand(["agent", "share", localAgent.id, "--expected-version", "2"], edge.edgeRoot);
    assert.equal(parsedShare.ok, true, JSON.stringify(parsedShare));
    if (!parsedShare.ok) throw new Error("edge agent share must parse");
    const shareResp = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 202,
      method: parsedShare.command.method,
      params: { repo: { repoId: "lease-repo" }, payload: { action: serializeFleetAction(parsedShare.command) } },
    });
    assert.ok(shareResp && !Array.isArray(shareResp) && "result" in shareResp, JSON.stringify(shareResp));
    const sharedResult = shareResp.result as Record<string, unknown>;
    assert.equal(sharedResult.outcome, "applied", JSON.stringify(sharedResult));
    assert.ok(f.eventCount() > beforeCreate, "share writes through center canonical event stream");
    const centerInspectAfterShare = await f.host.run(
      "lease-repo",
      { kind: "agent-inspect", agentId: localAgent.id },
      localAuthFixture(),
    );
    assert.equal(centerInspectAfterShare.outcome, "applied", JSON.stringify(centerInspectAfterShare));
    const centerSharedRev = JSON.parse(String(centerInspectAfterShare.evidence)).workspaceRevision as number;

    // 4. Edge `ha agent unshare` enforces center agent-delete policy before retaining local copy.
    f.owners.keycloak.revoke("person-one", "lease-repo", ["agent-delete"]);
    const parsedUnshareDenied = parseThinCommand(
      ["agent", "unshare", localAgent.id, "--expected-version", String(centerSharedRev)],
      edge.edgeRoot,
    );
    assert.equal(parsedUnshareDenied.ok, true, JSON.stringify(parsedUnshareDenied));
    if (!parsedUnshareDenied.ok) throw new Error("edge agent unshare must parse");
    const unshareDeniedResp = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 203,
      method: parsedUnshareDenied.command.method,
      params: {
        repo: { repoId: "lease-repo" },
        payload: { action: serializeFleetAction(parsedUnshareDenied.command) },
      },
    });
    assert.ok(
      unshareDeniedResp && !Array.isArray(unshareDeniedResp) && "result" in unshareDeniedResp,
      JSON.stringify(unshareDeniedResp),
    );
    assert.equal((unshareDeniedResp.result as Record<string, unknown>).code, "authorization_denied");

    // 5. Grant agent-delete -> unshare succeeds -> local delete removes edge local file with zero center events.
    f.owners.keycloak.permit("person-one", "lease-repo", ["agent-delete"]);
    const unshareOkResp = await edge.rpc.handle({
      jsonrpc: "2.0",
      id: 204,
      method: parsedUnshareDenied.command.method,
      params: {
        repo: { repoId: "lease-repo" },
        payload: { action: serializeFleetAction(parsedUnshareDenied.command) },
      },
    });
    assert.ok(
      unshareOkResp && !Array.isArray(unshareOkResp) && "result" in unshareOkResp,
      JSON.stringify(unshareOkResp),
    );
    assert.equal(
      (unshareOkResp.result as Record<string, unknown>).outcome,
      "applied",
      JSON.stringify(unshareOkResp.result),
    );
    const centerInspectAfterUnshare = await f.host.run(
      "lease-repo",
      { kind: "agent-inspect", agentId: localAgent.id },
      localAuthFixture(),
    );
    assert.equal(centerInspectAfterUnshare.outcome, "op_rejected", JSON.stringify(centerInspectAfterUnshare));

    const beforeLocalDelete = f.eventCount();
    const localDelete = await edge.command({
      kind: "agent-delete",
      agentId: localAgent.id,
      reason: "Delete edge-local agent.",
      expectedVersion: 1,
    });
    assert.equal(localDelete.outcome, "applied", JSON.stringify(localDelete));
    assert.equal(f.eventCount(), beforeLocalDelete, "local delete on remote-edge appends zero center events");
  },
);
