// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { compileEntityUpsert } from "../../src/domain/entity-event-compile.ts";
import {
  entityUpsertWritePlan,
  ownedContentForDeclarationEvent,
  type EntityDeclarationClaim,
  type EntityUpsertEventV1,
} from "../../src/domain/entity-event.ts";
import { requireEntityStoreKindContract } from "../../src/domain/entity-kind-registry.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { openSqliteEventStore, type SqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

const contract = requireEntityStoreKindContract("agent"),
  repoId = "legacy-agent-window",
  fence = { repoId, holder: "legacy-window-fixture", epoch: 1 } as const,
  actor = { principal: { personId: "person_synthetic" }, executor: null } as const;

/**
 * The migration-window fixture: one installed Agent declaration in the exact shape a
 * pre-runtimes daemon accepted (`runtime_type` string plus top-level `model`). Every current
 * write path validates declarations against today's schema, so the fixture appends the event the
 * way that old daemon did — a raw entity_upserted command (event, claim, blob) written straight
 * to the SQLite ledger under a writer fence, bypassing the bundle validation layer entirely.
 */
function legacyAgentCommand(opId: string, entityId: string, workspaceRevision: number) {
  const value = {
      schema: "agent-declaration/v1",
      id: entityId,
      name: "Legacy Worker",
      instructions: "Legacy fixture agent.",
      runtime_type: "zcode",
      model: "GLM-5.3",
    },
    body = `${JSON.stringify(value, null, 2)}\n`,
    claim: EntityDeclarationClaim = {
      path: `agents/${entityId}.json`,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: contract.entityStore.document.mediaType,
      policyId: contract.entityStore.document.policyId,
    },
    // No ownedContent field yet: ownedContentForDeclarationEvent recovers the accepted
    // pre-manifest shape (exactly one declaration document, nothing else) from the claim.
    event = {
      schema: "entity-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision,
      opId,
      actor,
      source: "local",
      occurredAt: "2026-09-18T00:00:00.000Z",
      type: "entity_upserted",
      payload: { entityKind: "agent", entityId, declarationDocumentClaim: claim },
    } as EntityUpsertEventV1,
    complete: EntityUpsertEventV1 = {
      ...event,
      payload: { ...event.payload, ownedContent: ownedContentForDeclarationEvent(event) },
    };
  return {
    intent: { opId, intentDigest: `sha256:${"a".repeat(64)}`, summary: complete.type },
    events: [complete as unknown as CanonicalEventV1],
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
    plan: entityUpsertWritePlan(complete),
  };
}

/** Current-shape declarations ride the ordinary compile path; the raw command append below only
 * keeps one writer fence for the whole ledger, exactly like the production single writer. */
function appendCurrentShapeAgent(writer: SqliteEventStore, input: Parameters<typeof compileEntityUpsert>[0]): void {
  const bundle = compileEntityUpsert(input);
  writer.appendCommand({
    fence,
    intent: { opId: input.opId, intentDigest: `sha256:${"b".repeat(64)}`, summary: bundle.event.type },
    events: [bundle.event as unknown as CanonicalEventV1],
    blobs: [...bundle.blobs],
  });
}

function openWindowLedger(rootDir: string, legacyWorker: boolean): SqliteEventStore {
  const writer = openSqliteEventStore({ repoId, rootInput: rootDir });
  writer.claimWriter(fence);
  if (legacyWorker) writer.appendCommand({ fence, ...legacyAgentCommand("op-legacy-agent", "legacy-worker", 1) });
  return writer;
}

test("replaying a pre-runtimes agent declaration degrades that row instead of failing the rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = openWindowLedger(rootDir, true);
    appendCurrentShapeAgent(writer, {
      eventId: "event-current-sibling",
      opId: "op-current-sibling",
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt: "2026-09-18T00:10:00.000Z",
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "current-sibling",
        name: "Current Sibling",
        instructions: "Current-shape fixture agent.",
        runtimes: [{ type: "claude" }],
      },
    });
    writer.close();
    const eventStore = makeTaskEventStore({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore });
    // The window assertion: opening the ledger (projection catch-up over the full log) must not
    // throw on the legacy declaration; that row degrades, the sibling stays current.
    projection.catchUp?.();
    const rows = projection.listEntities("agent");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === "legacy-worker")?.freshness, "unknown");
    const current = rows.find((row) => row.id === "current-sibling");
    assert.equal(current?.freshness, "current");
    assert.deepEqual((current?.value as { readonly runtimes: readonly unknown[] }).runtimes, [{ type: "claude" }]);
    projection.close();
    await eventStore.drain();
  });
});

test("reinstalling the legacy agent with the current shape restores its projection row", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = openWindowLedger(rootDir, true);
    writer.close();
    const eventStore = makeTaskEventStore({ repoId, rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore });
    projection.catchUp?.();
    const reinstall = openWindowLedger(rootDir, false);
    appendCurrentShapeAgent(reinstall, {
      eventId: "event-legacy-agent-reinstall",
      opId: "op-legacy-agent-reinstall",
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt: "2026-09-18T00:20:00.000Z",
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "legacy-worker",
        name: "Legacy Worker",
        instructions: "Legacy fixture agent, rewritten to the current shape.",
        runtimes: [
          { type: "zcode", model: "GLM-5.3" },
          { type: "claude", model: "GLM-5.3[1m]" },
        ],
      },
    });
    reinstall.close();
    projection.catchUp?.();
    const row = projection.getEntity("agent", "legacy-worker");
    assert.equal(row?.freshness, "current");
    assert.deepEqual((row?.value as { readonly runtimes: readonly unknown[] }).runtimes, [
      { type: "zcode", model: "GLM-5.3" },
      { type: "claude", model: "GLM-5.3[1m]" },
    ]);
    projection.close();
    await eventStore.drain();
  });
});
