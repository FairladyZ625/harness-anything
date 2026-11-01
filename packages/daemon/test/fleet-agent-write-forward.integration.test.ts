// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { DaemonHost } from "../src/daemon-host.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";

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
    const installed = await edge.command({ kind: "agent-install", packageSource, expectedVersion: 0 });
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
    const invalid = await edge.command({ kind: "agent-install", declaration: { ...agent, schema: "invalid" } });
    assert.equal(invalid.code, "invalid_manifest", JSON.stringify(invalid));
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
    const deleted = await edge.command({
      kind: "agent-delete",
      agentId: agent.id,
      expectedVersion: retired.revision,
      reason: "Remove retired worker.",
    });
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    const beforeDenied = f.eventCount();
    f.owners.keycloak.userPermissions.clear();
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
