// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  compileEntityUpsert,
  makeTaskEventReader,
  openSqliteEventStore,
  sha256Bytes,
  openEntityStore,
} from "@harness-anything/kernel";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { renderEvidencePayload } from "../src/repo-cell-evidence.ts";
import { assertAgentDispatchable, prepareAgentEntityDelete, readAgentDeclaration } from "../src/agent-entities.ts";

const binding = withPolicyGroup(
  {
    actor: { principal: { personId: "person-agent-action" }, executor: null },
    source: "local" as const,
  },
  "contributor",
);
// A remote edge with no role binding: neither a declared repo-write role nor the local default binding holds
// for it, so the policy is the only thing standing between this caller and a durable delete.
const unauthorized = {
  actor: {
    principal: { personId: "person-agent-action-reader" },
    executor: { kind: "agent" as const, id: "agent-action-reader-edge" },
  },
  source: "remote_direct" as const,
  keycloakAuthorization: undefined,
};
const declaration = {
  schema: "agent-declaration/v1",
  id: "unified-agent",
  name: "Unified Agent",
  instructions: "Execute the assigned mission through the canonical action route.",
  runtimes: [{ type: "codex" }],
};

test("Agent install uses the executable catalog with CAS, replay, readiness, and ActionResult", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-action-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("agent-action"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "agent-action-test",
  });
  try {
    const packageSource = path.join(rootDir, "source", declaration.id);
    mkdirSync(packageSource, { recursive: true });
    writeFileSync(path.join(packageSource, "agent.json"), `${JSON.stringify(declaration, null, 2)}\n`);
    const preview = await cell.run(
      {
        kind: "agent-install",
        packageSource,
        dryRun: true,
        expectedVersion: 0,
        idempotencyKey: "agent-action-preview",
      },
      binding,
    );
    assert.equal(preview.outcome, "pending");
    assert.equal(preview.acceptance, null);
    assert.equal(preview.proof, undefined);
    assert.deepEqual(preview.effects, []);
    assert.equal(preview.updatedProjection, null);

    const install = {
        kind: "agent-install",
        packageSource,
        expectedVersion: 0,
        idempotencyKey: "agent-action-install",
      },
      created = await cell.run(install, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.deepEqual(created.effects, ["entity-event/entity_upserted"]);
    assert.deepEqual(created.updatedProjection, {
      kind: "agent",
      ref: "agent/unified-agent",
      revision: created.revision,
    });
    await waitForFixturePublication(cell, created.opId, binding);
    const createdCommitSha = git(rootDir, "rev-parse", "HEAD");
    const createdPaths = git(
      rootDir,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      String(createdCommitSha),
    ).split("\n");
    assert.equal(createdPaths.includes("harness/events/segments/manifest.json"), true);
    assert.equal(createdPaths.includes("harness/agents/unified-agent.json"), true);
    assert.equal(
      JSON.parse(git(rootDir, "show", `${createdCommitSha}:harness/events/segments/manifest.json`)).cut.revision,
      created.revision,
    );
    assert.equal(created.detail?.kind, "entity_upsert");
    assert.equal(created.detail?.entityKind, "agent");
    const accepted = openSqliteEventStore({ repoId: workspaceId("agent-action"), rootInput: rootDir, readOnly: true });
    try {
      const event = accepted.event(created.opId);
      assert.equal(event?.type, "entity_upserted");
      if (event?.type !== "entity_upserted") throw new Error("accepted Agent event is not an upsert");
      assert.deepEqual(event.payload.ownedContent, {
        schema: "entity-owned-content/v1",
        ownerRef: "agent/unified-agent",
        schemaId: "agent-declaration/v1",
        schemaVersion: 1,
        content: [
          {
            sha256: event.payload.declarationDocumentClaim.sha256,
            byteLength: event.payload.declarationDocumentClaim.size,
            mediaType: "application/json",
          },
        ],
        bindings: [
          {
            path: "agents/unified-agent.json",
            contentSha256: event.payload.declarationDocumentClaim.sha256,
            policyId: "typed-entity/v1",
          },
        ],
        directories: [],
        retirements: [],
        directoryRetirements: [],
      });
    } finally {
      accepted.close();
    }

    const replayed = await cell.run(install, binding);
    assert.equal(replayed.outcome, "applied", JSON.stringify(replayed));
    assert.equal(replayed.opId, created.opId);
    assert.equal(replayed.revision, created.revision);

    const stale = await cell.run(
      {
        kind: "agent-install",
        declaration: { ...declaration, name: "Stale Agent" },
        expectedVersion: 0,
        idempotencyKey: "agent-action-stale",
      },
      binding,
    );
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "revision_conflict");
    assert.deepEqual(stale.unmetCriteria, [
      {
        ref: "agent/entity-revision",
        failureCode: "revision_conflict",
        explain: "When supplied, expectedVersion must match the latest Agent entity revision.",
      },
    ]);

    const placeholder = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          ...declaration,
          id: "placeholder-agent",
          instructions: "(To be written: this text becomes the agent's system prompt verbatim.)",
        },
        expectedVersion: 0,
        idempotencyKey: "agent-action-placeholder",
      },
      binding,
    );
    assert.equal(placeholder.outcome, "op_rejected");
    assert.equal(placeholder.code, "instructions_placeholder");
    assert.deepEqual(placeholder.unmetCriteria, [
      {
        ref: "agent/instructions-ready",
        failureCode: "instructions_placeholder",
        explain: "Agent instructions must contain authored content rather than the declaration scaffold.",
      },
    ]);

    const updated = await cell.run(
      {
        kind: "agent-install",
        declaration: { ...declaration, name: "Unified Agent Updated" },
        expectedVersion: created.revision,
        idempotencyKey: "agent-action-update",
      },
      binding,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    assert.equal(updated.revision > created.revision, true);

    const listedAgent = await cell.run({ kind: "agent-list" }, binding),
      inspectedAgent = await cell.run({ kind: "agent-inspect", agentId: declaration.id }, binding);
    assert.deepEqual(JSON.parse(String(listedAgent.evidence)), {
      schema: "agent-list/v1",
      agents: [
        {
          schema: declaration.schema,
          id: declaration.id,
          name: "Unified Agent Updated",
          runtimes: declaration.runtimes,
          layer: "user",
          source: "agents/unified-agent.json",
        },
      ],
      status: "ready",
      watermark: updated.revision,
      sourceRevision: updated.revision,
    });
    assert.deepEqual(JSON.parse(String(inspectedAgent.evidence)), {
      schema: "agent-inspection/v1",
      agent: { ...declaration, name: "Unified Agent Updated" },
      status: "ready",
      watermark: updated.revision,
      sourceRevision: updated.revision,
    });

    const squad = await cell.run(
      {
        kind: "squad-install",
        declaration: {
          schema: "squad-declaration/v1",
          id: "unified-squad",
          name: "Unified Squad",
          leader: declaration.id,
          workers: [declaration.id],
          leaderTurnBudget: 4,
          roster: "# Unified Squad\n\nUnified Agent leads.",
        },
        expectedVersion: 0,
        idempotencyKey: "squad-action-install",
      },
      binding,
    );
    assert.equal(squad.outcome, "applied", JSON.stringify(squad));
    const squadStore = openSqliteEventStore({
      repoId: workspaceId("agent-action"),
      rootInput: rootDir,
      readOnly: true,
    });
    try {
      const event = squadStore.event(squad.opId);
      assert.equal(event?.type, "entity_upserted");
      if (event?.type !== "entity_upserted") throw new Error("accepted Squad event is not an upsert");
      assert.equal(event.payload.ownedContent.ownerRef, "squad/unified-squad");
      assert.equal(event.payload.ownedContent.schemaId, "squad-declaration/v1");
    } finally {
      squadStore.close();
    }

    const deleteSquad = {
        kind: "squad-delete",
        squadId: "unified-squad",
        expectedVersion: squad.revision,
        reason: "Retire the test Squad current view.",
        idempotencyKey: "squad-action-delete",
      },
      refusedSquad = await cell.run(deleteSquad, unauthorized);
    assert.equal(refusedSquad.outcome, "op_rejected", JSON.stringify(refusedSquad));
    assert.equal(refusedSquad.authorizationDecision?.outcome, "denied", JSON.stringify(refusedSquad));
    assert.equal(refusedSquad.authorizationDecision?.policyRef, "keycloak-policy@1");
    const deletedSquad = await cell.run(deleteSquad, binding);
    assert.equal(deletedSquad.outcome, "applied", JSON.stringify(deletedSquad));
    assert.deepEqual(deletedSquad.effects, ["entity-event/entity_deleted"]);
    const replayedSquadDelete = await cell.run(deleteSquad, binding);
    assert.equal(replayedSquadDelete.opId, deletedSquad.opId);
    assert.equal(replayedSquadDelete.revision, deletedSquad.revision);

    const deleteAgent = {
        kind: "agent-delete",
        agentId: declaration.id,
        expectedVersion: updated.revision,
        reason: "Retire the test Agent current view.",
        idempotencyKey: "agent-action-delete",
      },
      refusedAgent = await cell.run(deleteAgent, unauthorized);
    assert.equal(refusedAgent.outcome, "op_rejected", JSON.stringify(refusedAgent));
    assert.equal(refusedAgent.authorizationDecision?.outcome, "denied", JSON.stringify(refusedAgent));
    assert.equal(refusedAgent.authorizationDecision?.policyRef, "keycloak-policy@1");
    const deleted = await cell.run(deleteAgent, binding);
    assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
    assert.deepEqual(deleted.effects, ["entity-event/entity_deleted"]);
    await waitForFixturePublication(cell, deleted.opId, binding);
    const replayedDelete = await cell.run(deleteAgent, binding);
    assert.equal(replayedDelete.opId, deleted.opId);
    assert.equal(replayedDelete.revision, deleted.revision);
    const deletedCommitSha = git(rootDir, "rev-parse", "HEAD");
    const deletedPaths = git(
      rootDir,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      String(deletedCommitSha),
    ).split("\n");
    assert.equal(deletedPaths.includes("harness/events/segments/manifest.json"), true);
    assert.equal(deletedPaths.includes("harness/agents/unified-agent.json"), true);
    assert.equal(
      JSON.parse(git(rootDir, "show", `${deletedCommitSha}:harness/events/segments/manifest.json`)).cut.revision,
      deleted.revision,
    );
    const deletedStore = openSqliteEventStore({
      repoId: workspaceId("agent-action"),
      rootInput: rootDir,
      readOnly: true,
    });
    try {
      const deletedEvent = deletedStore.event(deleted.opId),
        originalEvent = deletedStore.event(created.opId);
      assert.equal(deletedEvent?.type, "entity_deleted");
      if (deletedEvent?.type !== "entity_deleted" || originalEvent?.type !== "entity_upserted")
        throw new Error("Agent CRUD history is incomplete");
      assert.deepEqual(deletedEvent.payload.ownedContent.retirements, [
        {
          path: "agents/unified-agent.json",
          baseBlobSha256: deletedEvent.payload.ownedContent.retirements[0]?.baseBlobSha256,
        },
      ]);
      assert.deepEqual(
        deletedStore.readContentObject(originalEvent.payload.declarationDocumentClaim.sha256),
        Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`),
      );
    } finally {
      deletedStore.close();
    }

    const listed = await cell.run({ kind: "agent-list" }, binding);
    assert.deepEqual(JSON.parse(String(listed.evidence)).agents, []);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Agent install accepts a single declaration file as the package source", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-action-file-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("agent-action-file"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "agent-action-file-test",
  });
  try {
    const packageSource = path.join(rootDir, "solo-agent.json");
    writeFileSync(packageSource, `${JSON.stringify(declaration, null, 2)}\n`);
    const preview = await cell.run(
      {
        kind: "agent-install",
        packageSource,
        dryRun: true,
        expectedVersion: 0,
        idempotencyKey: "agent-action-file-preview",
      },
      binding,
    );
    assert.equal(preview.outcome, "pending");
    const created = await cell.run(
      {
        kind: "agent-install",
        packageSource,
        expectedVersion: 0,
        idempotencyKey: "agent-action-file-install",
      },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const listed = await cell.run({ kind: "agent-list" }, binding);
    assert.deepEqual(
      JSON.parse(String(listed.evidence)).agents.map(({ id }: { id: string }) => id),
      [declaration.id],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Agent retire publishes lifecycle state, is idempotent by operation, and blocks reinstallation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-retire-"));
  initRepo(rootDir);
  let cell = await openRepoCell({
    repoId: workspaceId("agent-retire"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "agent-retire-test",
  });
  try {
    const installed = await cell.run(
      { kind: "agent-install", declaration, expectedVersion: 0, idempotencyKey: "retire-install" },
      binding,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const squad = {
      schema: "squad-declaration/v1",
      id: "retired-member-squad",
      name: "Retired member",
      leader: declaration.id,
      workers: [declaration.id],
      leaderTurnBudget: 1,
      roster: "This squad retains its retired member identity.",
    };
    assert.equal((await cell.run({ kind: "squad-install", declaration: squad }, binding)).outcome, "applied");
    const retired = await cell.run(
      {
        kind: "agent-retire",
        agentId: declaration.id,
        reason: "No longer accepting new claims.",
        successor: "replacement-agent",
        idempotencyKey: "retire-agent",
      },
      binding,
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    assert.deepEqual(retired.effects, ["entity-event/agent_retired"]);
    const eventStore = openSqliteEventStore({
      repoId: workspaceId("agent-retire"),
      rootInput: rootDir,
      readOnly: true,
    });
    try {
      const event = eventStore.event(retired.opId);
      assert.equal(event?.type, "agent_retired");
      if (event?.type === "agent_retired") assert.equal(event.payload.successor, "replacement-agent");
      const stored = openEntityStore(rootDir).get("agent", declaration.id);
      assert.equal((stored?.value as { lifecycleState: string }).lifecycleState, "retired");
    } finally {
      eventStore.close();
    }
    const listed = await cell.run({ kind: "agent-list" }, binding);
    const row = JSON.parse(String(listed.evidence)).agents[0];
    assert.equal(row.lifecycleState, "retired", JSON.stringify(row));
    assert.equal(row.retirement.reason, "No longer accepting new claims.");
    assert.equal(row.retirement.successor, "replacement-agent");
    assert.match(
      renderEvidencePayload(JSON.parse(String(listed.evidence))),
      /retired\t.*successor=replacement-agent\treason=No longer accepting new claims/u,
    );
    const inspected = await cell.run({ kind: "agent-inspect", agentId: declaration.id }, binding);
    assert.equal(inspected.outcome, "applied", JSON.stringify(inspected));
    const agent = JSON.parse(String(inspected.evidence)).agent;
    assert.deepEqual(agent, { ...declaration, lifecycleState: "retired", retirement: row.retirement });
    assert.throws(
      () => assertAgentDispatchable(readAgentDeclaration({ rootDir, agentId: declaration.id })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "agent_retired");
        assert.match((error as Error).message, /replacement-agent/u);
        return true;
      },
    );
    await assert.rejects(
      () =>
        cell.spawnRuntime(
          {
            agentId: declaration.id,
            runtimeInstanceId: "unused-instance",
            prompt: "Preview retired agent dispatch",
            cwd: { scope: "repo-root" },
            dryRun: true,
            idempotencyKey: "retired-preview",
          },
          binding,
        ),
      (error: unknown) =>
        (error as { code?: string }).code === "agent_retired" && /replacement-agent/u.test((error as Error).message),
    );
    await waitForFixturePublication(cell, retired.opId, binding);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(rootDir, "harness/agents/unified-agent.json"), "utf8")),
      declaration,
    );
    assert.equal((await cell.run({ kind: "squad-inspect", squadId: squad.id }, binding)).outcome, "applied");
    const task = await cell.run(
      { kind: "task-create", taskId: "retire-task", title: "Retired squad dispatch" },
      binding,
    );
    assert.equal(task.outcome, "applied", JSON.stringify(task));
    await waitForFixturePublication(cell, task.opId, binding);
    await realizeTaskPlanFixture(rootDir, String((task as Record<string, unknown>).packagePath), (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "retire-task", executionId: "execution-retire" }, binding)).outcome,
      "applied",
    );
    const squadRun = await cell.run(
      {
        kind: "squad-run",
        squadId: squad.id,
        taskId: "retire-task",
        runtimeInstanceId: "not-launched",
        cwd: { scope: "repo-root" },
      },
      binding,
    );
    assert.equal(squadRun.code, "squad_agent_not_found", JSON.stringify(squadRun));
    assert.match(JSON.stringify(squadRun), /replacement-agent/u);
    const repeated = await cell.run(
      {
        kind: "agent-retire",
        agentId: declaration.id,
        reason: "No longer accepting new claims.",
        successor: "replacement-agent",
        idempotencyKey: "retire-agent",
      },
      binding,
    );
    assert.equal(repeated.outcome, "op_rejected", JSON.stringify(repeated));
    assert.equal(repeated.code, "agent_retired");
    const revived = await cell.run({ kind: "agent-install", declaration, idempotencyKey: "retire-reinstall" }, binding);
    assert.equal(revived.outcome, "op_rejected", JSON.stringify(revived));
    assert.equal(revived.code, "agent_retired");
    await cell.close();
    const stale = new DatabaseSync(path.join(rootDir, ".harness/cache/task.sqlite"));
    stale.exec("UPDATE projection_meta SET schema_version = 32 WHERE singleton = 1");
    stale.exec(
      "UPDATE entity_projection SET value_json = json_remove(value_json, '$.retirement') WHERE entity_kind = 'agent'",
    );
    stale.close();
    cell = await openRepoCell({
      repoId: workspaceId("agent-retire"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "agent-retire-reopened",
    });
    const replayed = await cell.run({ kind: "agent-inspect", agentId: declaration.id }, binding);
    assert.equal(replayed.outcome, "applied", JSON.stringify(replayed));
    assert.deepEqual(JSON.parse(String(replayed.evidence)).agent, agent);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("configured Agents are rejected by the center dispatch gate", () => {
  assert.throws(
    () => assertAgentDispatchable({ ...declaration, lifecycleState: "configured" }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "agent_not_active",
  );
});

test("Agent deletion reports a dispatch header reference even without taskId", () => {
  const entityStore = {
    get: () => ({
      kind: "agent",
      id: declaration.id,
      value: declaration,
      documentPath: "agents/unified-agent.json",
      documentSha256: "sha256:document",
      workspaceRevision: 3,
    }),
  } as never;
  assert.throws(
    () =>
      prepareAgentEntityDelete({
        action: { kind: "agent-delete", agentId: declaration.id, expectedVersion: 3, reason: "remove" },
        entityStore,
        projection: {
          readRuntimeDispatches: () => [{ payload: { agentId: declaration.id } }],
          listEntities: () => [],
          readRelationQuery: () => ({ rows: [] }),
        },
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "agent_referenced");
      assert.deepEqual((error as { references?: unknown }).references, [{ kind: "dispatch", count: 1 }]);
      return true;
    },
  );
});

test("owned-content objects preserve raw bytes and reject absent or oversized content", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-owned-content-")),
    repoId = workspaceId("entity-owned-content"),
    bytes = Uint8Array.from([0x00, 0xff, 0x80, 0x0a]),
    sha256 = sha256Bytes(bytes),
    base = compileEntityUpsert({
      entityKind: "agent",
      entity: declaration,
      eventId: "event-owned-content-binary",
      opId: "op-owned-content-binary",
      workspaceRevision: 1,
      actor: binding.actor,
      source: binding.source,
      occurredAt: "2026-09-09T00:00:00.000Z",
    }),
    event = {
      ...base.event,
      payload: {
        ...base.event.payload,
        declarationDocumentClaim: {
          ...base.event.payload.declarationDocumentClaim,
          sha256,
          size: bytes.byteLength,
        },
        // The compiled manifest, re-pointed at the raw bytes this case appends by hand.
        ownedContent: {
          ...base.event.payload.ownedContent,
          content: [{ sha256, byteLength: bytes.byteLength, mediaType: "application/json" }],
          bindings: base.event.payload.ownedContent.bindings.map((held) => ({ ...held, contentSha256: sha256 })),
        },
      },
    },
    store = openSqliteEventStore({ repoId, rootInput: rootDir }),
    fence = { repoId, holder: "owned-content-test", epoch: 1 },
    intent = {
      opId: event.opId,
      intentDigest: `sha256:${"1".repeat(64)}` as const,
      summary: "raw owned content",
    };
  try {
    store.claimWriter(fence);
    assert.throws(
      () => store.appendCommand({ fence, intent, events: [event], blobs: [] }),
      /content object .* is missing/u,
    );
    assert.equal(store.revision(), 0);
    assert.equal(store.outcome(event.opId), null);
    store.appendCommand({
      fence,
      intent,
      events: [event],
      blobs: [{ sha256, size: bytes.byteLength, mediaType: "application/json", body: bytes }],
    });
    assert.deepEqual(store.readContentObject(sha256), Buffer.from(bytes));
    const secondEvent = {
      ...event,
      eventId: "event-owned-content-binary-reuse",
      opId: "op-owned-content-binary-reuse",
      workspaceRevision: 2,
    };
    store.appendCommand({
      fence,
      intent: {
        opId: secondEvent.opId,
        intentDigest: `sha256:${"2".repeat(64)}`,
        summary: "reuse raw owned content",
      },
      events: [secondEvent],
      blobs: [],
    });
    assert.equal(store.revision(), 2);
  } finally {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("RepoCell fixtures preserve an unnamed local caller's missing authority", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-action-no-authority-")),
    repoId = workspaceId("agent-action-no-authority");
  initRepo(rootDir);
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "no-authority-test" }),
    reader = makeTaskEventReader({ repoId, rootDir });
  try {
    const local = { actor: binding.actor, source: "local" as const };
    for (const caller of [local, { ...local, keycloakAuthorization: undefined }]) {
      const denied = await cell.run({ kind: "agent-install", declaration }, caller);
      assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
      assert.equal(denied.authorizationDecision?.outcome, "denied");
      assert.equal(denied.acceptance, null);
      assert.equal(reader.readEvent(denied.opId), null);
    }
    const allowed = await cell.run({ kind: "agent-install", declaration }, binding);
    assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));
  } finally {
    await reader.drain();
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
