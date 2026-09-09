// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { compileEntityUpsert, openSqliteEventStore, sha256Bytes } from "../../kernel/src/index.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

const binding = {
  actor: { principal: { personId: "person-agent-action" }, executor: null },
  source: "local" as const,
};
const declaration = {
  schema: "agent-declaration/v1",
  id: "unified-agent",
  name: "Unified Agent",
  instructions: "Execute the assigned mission through the canonical action route.",
  runtime_type: "codex",
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
        retirements: [],
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
      deletedSquad = await cell.run(deleteSquad, binding);
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
      deleted = await cell.run(deleteAgent, binding);
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
