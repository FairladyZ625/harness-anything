// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteEventStore } from "@harness-anything/storage";
import { readLocalAgentDeclarations, writeLocalAgentDeclaration } from "../src/daemon-host/local-agent-store.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { readAgentDeclaration } from "../src/daemon-host/agent-entities.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "person-agent-scope" }, executor: null }, source: "local" as const },
  "contributor",
);

test("local Agents avoid the shared event stream and share/unshare through the canonical writer", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-scope-")),
    userRoot = path.join(rootDir, ".daemon-user"),
    repoId = workspaceId("agent-scope");
  initRepo(rootDir);
  mkdirSync(userRoot, { recursive: true });
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    userRoot,
    ownerId: "agent-scope-test",
  });
  try {
    const declaration = {
        schema: "agent-declaration/v1" as const,
        id: "private-helper",
        name: "Private helper",
        instructions: "Run local experiments.",
        runtimes: [{ type: "codex" }],
        scope: "local" as const,
      },
      local = await cell.run(
        { kind: "agent-install", declaration, scope: "local", expectedVersion: 0, idempotencyKey: "local-create" },
        binding,
      );
    assert.equal(local.outcome, "applied", JSON.stringify(local));
    assert.equal(local.effects.length, 0);
    const localStore = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
    try {
      assert.equal(localStore.event(local.opId), null);
    } finally {
      localStore.close();
    }
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "private-helper.json")), false);
    assert.deepEqual(
      readAgentDeclaration({ rootDir: canonicalRoot(rootDir), userRoot, repoId, agentId: declaration.id }),
      {
        ...declaration,
        scope: "local",
      },
    );
    assert.deepEqual(
      readLocalAgentDeclarations(userRoot, repoId).map(({ id, scope }) => [id, scope]),
      [[declaration.id, "local"]],
    );
    const localRows = JSON.parse(String((await cell.run({ kind: "agent-list", scope: "local" }, binding)).evidence));
    assert.deepEqual(
      localRows.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "local"]],
      JSON.stringify(localRows),
    );
    const localInspection = JSON.parse(
      String((await cell.run({ kind: "agent-inspect", agentId: declaration.id }, binding)).evidence),
    );
    assert.equal(localInspection.agent.scope, "local");
    assert.equal(localInspection.workspaceRevision, 1);
    const firstDetail = (await cell.read("repo.agent.entity.read", { agentId: declaration.id })) as {
      readonly agent: { readonly revision: number };
    };
    assert.equal(firstDetail.agent.revision, 1);
    const updatedDeclaration = { ...declaration, instructions: "Updated local experiment." };
    const updatedLocal = await cell.run(
      {
        kind: "agent-install",
        declaration: updatedDeclaration,
        expectedVersion: firstDetail.agent.revision,
        idempotencyKey: "local-update",
      },
      binding,
    );
    assert.equal(updatedLocal.outcome, "applied", JSON.stringify(updatedLocal));
    const updatedDetail = (await cell.read("repo.agent.entity.read", { agentId: declaration.id })) as {
      readonly agent: { readonly revision: number };
    };
    assert.equal(updatedDetail.agent.revision, 2);

    const published = await cell.run(
      {
        kind: "agent-install",
        agentId: declaration.id,
        scope: "shared",
        localAgentTransfer: true,
        expectedVersion: updatedDetail.agent.revision,
        idempotencyKey: "local-publish",
      },
      binding,
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));
    await waitForFixturePublication(cell, published.opId, binding);
    assert.equal(existsSync(path.join(userRoot, "local-agents", repoId, "private-helper.json")), false);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "private-helper.json")), true);

    writeLocalAgentDeclaration(userRoot, repoId, updatedDeclaration, 0);
    const recoveredPublishList = JSON.parse(String((await cell.run({ kind: "agent-list" }, binding)).evidence));
    assert.deepEqual(
      recoveredPublishList.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "shared"]],
    );
    const recoveredPublish = await cell.run(
      {
        kind: "agent-install",
        agentId: declaration.id,
        scope: "shared",
        localAgentTransfer: true,
        expectedVersion: 1,
        idempotencyKey: "local-publish-retry",
      },
      binding,
    );
    assert.equal(recoveredPublish.outcome, "applied", JSON.stringify(recoveredPublish));
    await waitForFixturePublication(cell, recoveredPublish.opId, binding);
    assert.equal(existsSync(path.join(userRoot, "local-agents", repoId, "private-helper.json")), false);

    const sharedRow = JSON.parse(String((await cell.run({ kind: "agent-list", scope: "shared" }, binding)).evidence));
    assert.deepEqual(
      sharedRow.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "shared"]],
    );
    const sharedRevision = recoveredPublish.updatedProjection?.revision;
    assert.equal(typeof sharedRevision, "number");
    writeLocalAgentDeclaration(userRoot, repoId, updatedDeclaration, 0);
    const recoveredUnshareList = JSON.parse(String((await cell.run({ kind: "agent-list" }, binding)).evidence));
    assert.deepEqual(
      recoveredUnshareList.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "shared"]],
    );
    const returned = await cell.run(
      {
        kind: "agent-install",
        agentId: declaration.id,
        scope: "local",
        localAgentTransfer: true,
        expectedVersion: sharedRevision,
        idempotencyKey: "shared-return-local",
      },
      binding,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    await waitForFixturePublication(cell, returned.opId, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "private-helper.json")), false);
    assert.equal(existsSync(path.join(userRoot, "local-agents", repoId, "private-helper.json")), true);
    const returnedLocal = JSON.parse(
      String((await cell.run({ kind: "agent-list", scope: "local" }, binding)).evidence),
    );
    assert.deepEqual(
      returnedLocal.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "local"]],
    );

    const guiPublished = await cell.run(
      {
        kind: "agent-install",
        declaration: { ...declaration, scope: "shared" },
        expectedVersion: returned.revision,
        idempotencyKey: "gui-local-publish",
      },
      binding,
    );
    assert.equal(guiPublished.outcome, "applied", JSON.stringify(guiPublished));
    await waitForFixturePublication(cell, guiPublished.opId, binding);
    const guiSharedRevision = guiPublished.updatedProjection?.revision;
    assert.equal(typeof guiSharedRevision, "number");
    const guiReturned = await cell.run(
      {
        kind: "agent-install",
        declaration: { ...declaration, scope: "local" },
        expectedVersion: guiSharedRevision,
        idempotencyKey: "gui-shared-return-local",
      },
      binding,
    );
    assert.equal(guiReturned.outcome, "applied", JSON.stringify(guiReturned));
    await waitForFixturePublication(cell, guiReturned.opId, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "private-helper.json")), false);
    assert.equal(existsSync(path.join(userRoot, "local-agents", repoId, "private-helper.json")), true);
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});
