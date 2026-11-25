// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteEventStore } from "@harness-anything/storage";
import { agentDeclarationContentDigest } from "@harness-anything/kernel";
import { executeAgentScopeInstall } from "@harness-anything/application/commands";
import {
  createLocalAgentStorePort,
  readLocalAgentDeclarations,
  readLocalAgentRecord,
  writeLocalAgentDeclaration,
} from "../src/daemon-host/local-agent-store.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { readAgentDeclaration } from "../src/daemon-host/agent-entities.ts";
import {
  openBootstrappedRepoCell,
  registerBootstrappedDaemonRepo,
  registerFixtureRuntimeInstance,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { policyTestRealm, signInPolicyTestUser, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { auth as unixSocketAuth } from "./daemon-host-recovery.fixture.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "person-agent-scope" }, executor: null }, source: "local" as const },
  "contributor",
);

function assertNoSharedAgentEvent(rootDir: string, repoId: string, opId: string): void {
  const localStore = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
  try {
    assert.equal(localStore.event(opId), null);
  } finally {
    localStore.close();
  }
}

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
        expectedVersion: sharedRevision,
        idempotencyKey: "shared-return-local",
      },
      binding,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assertNoSharedAgentEvent(rootDir, repoId, returned.opId);
    await waitForFixturePublication(cell, `agent-unshare-${returned.opId}`, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "private-helper.json")), false);
    assert.equal(existsSync(path.join(userRoot, "local-agents", repoId, "private-helper.json")), true);
    const returnedLocal = JSON.parse(
      String((await cell.run({ kind: "agent-list", scope: "local" }, binding)).evidence),
    );
    assert.deepEqual(
      returnedLocal.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "local"]],
    );
    const returnedInspection = JSON.parse(
      String((await cell.run({ kind: "agent-inspect", agentId: declaration.id }, binding)).evidence),
    );
    assert.equal(returnedInspection.agent.scope, "local");

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
    assertNoSharedAgentEvent(rootDir, repoId, guiReturned.opId);
    await waitForFixturePublication(cell, `agent-unshare-${guiReturned.opId}`, binding);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "private-helper.json")), false);
    assert.equal(existsSync(path.join(userRoot, "local-agents", repoId, "private-helper.json")), true);
    const guiReturnedLocal = JSON.parse(
      String((await cell.run({ kind: "agent-list", scope: "local" }, binding)).evidence),
    );
    assert.deepEqual(
      guiReturnedLocal.agents.map((agent: { id: string; scope: string }) => [agent.id, agent.scope]),
      [[declaration.id, "local"]],
    );
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});

test("local dryRun writes nothing and enforces instructions-ready compile validation (F-DRY)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-scope-dry-")),
    userRoot = path.join(rootDir, ".daemon-user"),
    repoId = workspaceId("agent-scope-dry");
  initRepo(rootDir);
  mkdirSync(userRoot, { recursive: true });
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    userRoot,
    ownerId: "agent-scope-dry-test",
  });
  try {
    const declaration = {
        schema: "agent-declaration/v1" as const,
        id: "dry-local-helper",
        name: "Dry Local Helper",
        instructions: "Run verified dry-run experiments.",
        runtimes: [{ type: "codex" }],
        scope: "local" as const,
      },
      preview = await cell.run(
        {
          kind: "agent-install",
          declaration,
          scope: "local",
          dryRun: true,
          expectedVersion: 0,
          idempotencyKey: "local-dry-run",
        },
        binding,
      );
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    assert.equal(preview.acceptance ?? null, null);
    assert.equal(preview.proof, undefined);
    assert.equal(readLocalAgentRecord(userRoot, repoId, declaration.id), null);
    assertNoSharedAgentEvent(rootDir, repoId, preview.opId);

    const placeholder = {
      ...declaration,
      id: "placeholder-local",
      instructions: "(To be written: this text becomes the agent's system prompt verbatim.)",
    };
    const dryRejected = await cell.run(
      {
        kind: "agent-install",
        declaration: placeholder,
        scope: "local",
        dryRun: true,
        expectedVersion: 0,
        idempotencyKey: "local-placeholder-dry",
      },
      binding,
    );
    assert.equal(dryRejected.outcome, "op_rejected", JSON.stringify(dryRejected));
    assert.equal(dryRejected.code, "instructions_placeholder", JSON.stringify(dryRejected));
    const applyRejected = await cell.run(
      {
        kind: "agent-install",
        declaration: placeholder,
        scope: "local",
        expectedVersion: 0,
        idempotencyKey: "local-placeholder-apply",
      },
      binding,
    );
    assert.equal(applyRejected.outcome, "op_rejected", JSON.stringify(applyRejected));
    assert.equal(applyRejected.code, "instructions_placeholder", JSON.stringify(applyRejected));
    assert.equal(readLocalAgentRecord(userRoot, repoId, placeholder.id), null);
  } finally {
    await cell.close();
    removeTempRepository(rootDir);
  }
});

test("unshare requires agent-delete policy, compensates pre-commit rejections, and supports local delete (F-DELETE-AUTH, F-UNSHARE, F-LOCAL-CRUD)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-scope-auth-")),
    userRoot = path.join(rootDir, ".daemon-user"),
    repoId = workspaceId("agent-scope-auth"),
    actorBinding = withPolicyGroup(
      { actor: { principal: { personId: "person-scope-auth" }, executor: null }, source: "local" as const },
      "contributor",
    );
  initRepo(rootDir);
  mkdirSync(userRoot, { recursive: true });
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    userRoot,
    ownerId: "agent-scope-auth-test",
  });
  try {
    const sharedDecl = {
        schema: "agent-declaration/v1" as const,
        id: "policy-guarded-worker",
        name: "Policy Guarded Worker",
        instructions: "Execute verified team tasks.",
        runtimes: [{ type: "codex" }],
        scope: "shared" as const,
      },
      installed = await cell.run(
        { kind: "agent-install", declaration: sharedDecl, expectedVersion: 0, idempotencyKey: "install-shared" },
        actorBinding,
      );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    await waitForFixturePublication(cell, installed.opId, actorBinding);
    const sharedRevision = installed.updatedProjection?.revision ?? 1;

    // Revoke agent-delete while keeping agent-install allowed.
    policyTestRealm.keycloak.revoke("person-scope-auth", repoId, ["agent-delete"]);
    const denied = await cell.run(
      {
        kind: "agent-install",
        agentId: sharedDecl.id,
        scope: "local",
        expectedVersion: sharedRevision,
        idempotencyKey: "unshare-without-delete-perm",
      },
      actorBinding,
    );
    assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
    assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", `${sharedDecl.id}.json`)), true);
    assert.equal(readLocalAgentRecord(userRoot, repoId, sharedDecl.id), null);

    // Re-grant agent-delete, but verify pre-commit rejection (Squad reference) removes staged local copy.
    policyTestRealm.keycloak.permit("person-scope-auth", repoId, ["agent-delete"]);
    const leaderDecl = {
      ...sharedDecl,
      id: "squad-leader-ref",
      name: "Squad Leader Ref",
      role: "commander" as const,
    };
    const leaderInstalled = await cell.run(
      { kind: "agent-install", declaration: leaderDecl, expectedVersion: 0, idempotencyKey: "install-leader" },
      actorBinding,
    );
    assert.equal(leaderInstalled.outcome, "applied", JSON.stringify(leaderInstalled));
    const squadInstalled = await cell.run(
      {
        kind: "squad-install",
        declaration: {
          schema: "squad-declaration/v1",
          id: "ref-squad",
          name: "Ref Squad",
          leader: leaderDecl.id,
          workers: [sharedDecl.id],
          leaderTurnBudget: 4,
          roster: "# Ref Squad\n\nCoordinates the guarded worker and checks outputs.",
        },
        expectedVersion: 0,
        idempotencyKey: "install-ref-squad",
      },
      actorBinding,
    );
    assert.equal(squadInstalled.outcome, "applied", JSON.stringify(squadInstalled));
    const refBlocked = await cell.run(
      {
        kind: "agent-install",
        agentId: sharedDecl.id,
        scope: "local",
        expectedVersion: sharedRevision,
        idempotencyKey: "unshare-blocked-by-squad",
      },
      actorBinding,
    );
    assert.equal(refBlocked.outcome, "op_rejected", JSON.stringify(refBlocked));
    assert.equal(refBlocked.code, "agent_referenced", JSON.stringify(refBlocked));
    assert.equal(readLocalAgentRecord(userRoot, repoId, sharedDecl.id), null);

    // Remove squad reference -> unshare succeeds -> local delete works with CAS revision fence.
    const squadRemoved = await cell.run(
      {
        kind: "squad-delete",
        squadId: "ref-squad",
        reason: "Cleanup squad reference.",
        expectedVersion: squadInstalled.updatedProjection?.revision ?? 1,
        idempotencyKey: "delete-ref-squad",
      },
      actorBinding,
    );
    assert.equal(squadRemoved.outcome, "applied", JSON.stringify(squadRemoved));
    const unshared = await cell.run(
      {
        kind: "agent-install",
        agentId: sharedDecl.id,
        scope: "local",
        expectedVersion: sharedRevision,
        idempotencyKey: "unshare-after-grant",
      },
      actorBinding,
    );
    assert.equal(unshared.outcome, "applied", JSON.stringify(unshared));
    await waitForFixturePublication(cell, `agent-unshare-${unshared.opId}`, actorBinding);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", `${sharedDecl.id}.json`)), false);
    assert.equal(readLocalAgentRecord(userRoot, repoId, sharedDecl.id)?.revision, 1);

    const staleDelete = await cell.run(
      {
        kind: "agent-delete",
        agentId: sharedDecl.id,
        reason: "Wrong revision.",
        expectedVersion: 99,
        idempotencyKey: "local-delete-stale",
      },
      actorBinding,
    );
    assert.equal(staleDelete.outcome, "op_rejected", JSON.stringify(staleDelete));
    assert.equal(staleDelete.code, "revision_conflict", JSON.stringify(staleDelete));
    assert.notEqual(readLocalAgentRecord(userRoot, repoId, sharedDecl.id), null);

    const localDeleted = await cell.run(
      {
        kind: "agent-delete",
        agentId: sharedDecl.id,
        reason: "Remove local agent.",
        expectedVersion: 1,
        idempotencyKey: "local-delete-ok",
      },
      actorBinding,
    );
    assert.equal(localDeleted.outcome, "applied", JSON.stringify(localDeleted));
    assertNoSharedAgentEvent(rootDir, repoId, localDeleted.opId);
    assert.equal(readLocalAgentRecord(userRoot, repoId, sharedDecl.id), null);

    // Edited GUI publish draft retry converges cleanly without agent_scope_conflict (F-UNSHARE).
    const draftLocal = {
      schema: "agent-declaration/v1" as const,
      id: "gui-edited-publish",
      name: "GUI Edited Publish",
      instructions: "Original local draft.",
      runtimes: [{ type: "codex" }],
      scope: "local" as const,
    };
    const editedShared = {
      ...draftLocal,
      instructions: "Edited instructions published to shared.",
      scope: "shared" as const,
    };
    const seededShared = await cell.run(
      { kind: "agent-install", declaration: editedShared, expectedVersion: 0, idempotencyKey: "seed-edited-shared" },
      actorBinding,
    );
    assert.equal(seededShared.outcome, "applied", JSON.stringify(seededShared));
    await waitForFixturePublication(cell, seededShared.opId, actorBinding);
    writeLocalAgentDeclaration(userRoot, repoId, draftLocal, {
      expectedVersion: 0,
      pendingTransfer: {
        direction: "share",
        operationId: "interrupted-gui-publish",
        sourceRevision: 1,
        targetScope: "shared",
        declarationSha256: agentDeclarationContentDigest(editedShared),
      },
    });
    const listDuringRetry = JSON.parse(String((await cell.run({ kind: "agent-list" }, actorBinding)).evidence));
    assert.equal(
      listDuringRetry.agents.find((row: { id: string }) => row.id === draftLocal.id)?.scope,
      "shared",
      JSON.stringify(listDuringRetry),
    );
    const retryPublish = await cell.run(
      {
        kind: "agent-install",
        declaration: editedShared,
        expectedVersion: 1,
        idempotencyKey: "retry-gui-edited-publish",
      },
      actorBinding,
    );
    assert.equal(retryPublish.outcome, "applied", JSON.stringify(retryPublish));
    assert.equal(readLocalAgentRecord(userRoot, repoId, draftLocal.id), null);
  } finally {
    policyTestRealm.keycloak.permit("person-scope-auth", repoId, ["agent-delete"]);
    await cell.close();
    removeTempRepository(rootDir);
  }
});

test("unshare retains local copy when shared delete is durable-pending or throws after commit (F-UNSHARE)", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-unshare-pending-")),
    repoId = "unshare-pending-repo",
    localStore = createLocalAgentStorePort(userRoot, repoId),
    declaration = {
      schema: "agent-declaration/v1" as const,
      id: "durable-pending-agent",
      name: "Durable Pending Agent",
      instructions: "Never lose my only live copy on post-commit error.",
      runtimes: [{ type: "codex" }],
      scope: "local" as const,
    },
    allowedDecision = {
      outcome: "allowed" as const,
      policyRef: "test-policy",
      reasonCodes: ["granted"],
      evaluatedAtCut: "0",
    };
  try {
    const pendingResult = await executeAgentScopeInstall(
      {
        localStore,
        shared: { value: { ...declaration, scope: "shared" }, revision: 3 },
        compileDeclaration: () => undefined,
        appliedCutWatermark: () => 3,
        installSharedAgent: () => {
          throw new Error("unexpected share");
        },
        deleteSharedAgent: async ({ opId }) => ({
          outcome: "pending",
          opId,
          effects: [],
          updatedProjection: null,
          proof: {
            committedRevision: 4,
            appliedCut: 3,
            durable: true,
            canonicalVisible: false,
            worktreeVisible: false,
          },
        }),
      },
      {
        action: { kind: "agent-install", agentId: declaration.id, scope: "local", expectedVersion: 3 },
        declaration,
        opId: "op-pending-unshare",
        authorizationDecision: allowedDecision,
      },
    );
    assert.equal(pendingResult?.outcome, "pending");
    assert.equal(pendingResult?.code, "agent_unshare_pending");
    const retainedAfterPending = localStore.get(declaration.id);
    assert.notEqual(retainedAfterPending, null);
    assert.equal(retainedAfterPending?.pendingTransfer?.direction, "unshare");

    localStore.remove(declaration.id);
    await assert.rejects(
      () =>
        executeAgentScopeInstall(
          {
            localStore,
            shared: { value: { ...declaration, scope: "shared" }, revision: 3 },
            compileDeclaration: () => undefined,
            appliedCutWatermark: () => 3,
            installSharedAgent: () => {
              throw new Error("unexpected share");
            },
            deleteSharedAgent: async () => {
              throw new Error("simulated after_append crash");
            },
          },
          {
            action: { kind: "agent-install", agentId: declaration.id, scope: "local", expectedVersion: 3 },
            declaration,
            opId: "op-crash-unshare",
            authorizationDecision: allowedDecision,
          },
        ),
      /simulated after_append crash/u,
    );
    assert.notEqual(localStore.get(declaration.id), null, "uncertain thrown delete must retain local copy");
  } finally {
    removeTempRepository(userRoot);
  }
});

test("registered daemon host passes userRoot end-to-end for local Agents (F-ROOT)", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-scope-host-")),
    userRoot = path.join(rootDir, ".daemon-user"),
    repoId = workspaceId("agent-scope-host");
  initRepo(rootDir);
  mkdirSync(userRoot, { recursive: true });
  registerBootstrappedDaemonRepo({
    repoId,
    canonicalRoot: canonicalRoot(rootDir),
    userRoot,
    createConvenienceLinks: false,
  });
  signInPolicyTestUser(userRoot, "person-scope-host", [repoId], "contributor");
  const installation = {
    installationId: "scope-host-codex",
    kindId: "codex" as const,
    executablePath: process.execPath,
    version: "1.0.0",
    observedAt: "2026-11-01T00:00:00.000Z",
  };
  const host = await openDaemonHost({
    daemonId: "agent-scope-host-daemon",
    userRoot,
    runtimeDiscover: async () => [installation],
    keycloakCenter: async () => ({
      url: policyTestRealm.url,
      realm: "harness",
      clientId: "harness-center",
      accessToken: "center-token",
      provider: withPolicyGroup(
        { actor: { principal: { personId: "person-scope-host" }, executor: null } },
        "contributor",
      ).keycloakAuthorization.session.provider,
    }),
  });
  try {
    await host.attachmentsSettled();
    await registerFixtureRuntimeInstance(host, repoId, unixSocketAuth, {
      instanceId: "scope-host-codex",
      name: "Scope Host Codex",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    const declaration = {
        schema: "agent-declaration/v1" as const,
        id: "host-local-agent",
        name: "Host Local Agent",
        instructions: "Created through the real daemon host registry path.",
        runtimes: [{ type: "codex" }],
        scope: "local" as const,
      },
      created = await host.run(
        repoId,
        { kind: "agent-install", declaration, scope: "local", expectedVersion: 0, idempotencyKey: "host-local-create" },
        unixSocketAuth,
      );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assertNoSharedAgentEvent(rootDir, repoId, created.opId);
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", `${declaration.id}.json`)), false);
    assert.notEqual(readLocalAgentRecord(userRoot, repoId, declaration.id), null);

    const listed = await host.run(repoId, { kind: "agent-list", scope: "local" }, unixSocketAuth);
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.deepEqual(
      JSON.parse(String(listed.evidence)).agents.map((row: { id: string; scope: string }) => [row.id, row.scope]),
      [[declaration.id, "local"]],
    );
    const guiList = (await host.read(repoId, "repo.agent.entities.list", {}, unixSocketAuth)) as {
      readonly agents: readonly { readonly id: string; readonly scope?: string }[];
    };
    assert.equal(guiList.agents.find((row) => row.id === declaration.id)?.scope, "local");
  } finally {
    await host.close();
    removeTempRepository(rootDir);
  }
});
