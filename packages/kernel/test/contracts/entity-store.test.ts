// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createEntityStore, explainEntityKind } from "../../src/index.ts";
import { validateAgentDeclarationV1 } from "../../src/domain/agent-squad-schema.ts";
import {
  assertEntityUpsertInputs,
  type EntityEventV1,
  type EntityUpsertBundle,
} from "../../src/domain/entity-event.ts";
import { validateWriteReceipt } from "../../src/domain/write-chain.contract.ts";

const actor = { principal: { personId: "person-entity-store" }, executor: null } as const;
const agent = {
  schema: "agent-declaration/v1",
  id: "terra",
  name: "Terra",
  instructions: "Review precisely.",
  runtime_type: "codex",
};
const squad = {
  schema: "squad-declaration/v1",
  id: "core-squad",
  name: "Core Squad",
  leader: "terra",
  workers: ["terra"],
  roster: "# Core Squad",
};

test("registered declaration Entity kinds explain the same contract shape from their JSON schemas", () => {
  const explanations = [explainEntityKind("agent"), explainEntityKind("squad")];
  assert.deepEqual(Object.keys(explanations[0]!).sort(), Object.keys(explanations[1]!).sort());
  for (const explanation of explanations) {
    assert.deepEqual(Object.keys(explanation.documentSchema.fields[0]!).sort(), [
      "description",
      "name",
      "required",
      "type",
    ]);
    assert.equal(explanation.id.field, "id");
    assert.equal(explanation.relations.directions.length, 0);
    assert.deepEqual(explanation.canonicalProjection, {
      embeddedEvents: [],
      row: { idField: "id", ownerField: null },
    });
  }
  assert.deepEqual(
    { catalogRef: explanations[0]!.transitions.catalogRef, available: explanations[0]!.transitions.available },
    {
      catalogRef: "kernel/agent-declaration/v1",
      available: ["configure", "activate", "retire"],
    },
  );
  assert.deepEqual(
    { catalogRef: explanations[1]!.transitions.catalogRef, available: explanations[1]!.transitions.available },
    { catalogRef: null, available: [] },
  );
  assert.equal(explanations[0]!.documentSchema.fields.find(({ name }) => name === "runtime_type")?.required, true);
  assert.match(
    validateAgentDeclarationV1({
      schema: agent.schema,
      id: agent.id,
      name: agent.name,
      instructions: agent.instructions,
    }).join("\n"),
    /missing required field "runtime_type"/u,
  );
  assert.throws(
    () => explainEntityKind("unknown"),
    (error: unknown) => {
      return (error as { code?: string }).code === "entity_kind_not_found";
    },
  );
});

test("Agent fallback is an exact chain-bounded attempt declaration", () => {
  const fallback = {
    chain: [{ instance: "provider-a" }, { instance: "provider-b", model: "model-b" }],
    backoff: { baseMs: 25, maxMs: 100 },
  };
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, fallback }), []);
  assert.match(
    validateAgentDeclarationV1({ ...agent, fallback: { ...fallback, unknown: true } }).join("\n"),
    /fallback.*unknown/u,
  );
  assert.match(
    validateAgentDeclarationV1({ ...agent, fallback: { ...fallback, enabled: true } }).join("\n"),
    /enabled.*unknown/u,
  );
  assert.match(
    validateAgentDeclarationV1({
      ...agent,
      fallback: { ...fallback, backoff: { ...fallback.backoff, maxAttempts: 3 } },
    }).join("\n"),
    /maxAttempts.*unknown/u,
  );
});

test("RuntimeSession explains its identity, task handoff, status vocabulary, and executes edge", () => {
  const explanation = explainEntityKind("runtime-session");
  assert.equal(explanation.id.field, "runtimeSessionId");
  assert.deepEqual(explanation.relations.edges, [
    { type: "executes", sourceKind: "runtime-session", targetKind: "task" },
  ]);
  assert.deepEqual(explanation.statusVocabulary, [
    { field: "liveness", words: ["live", "stale", "unknown", "exited"] },
    { field: "outcome", words: ["succeeded", "failed", "unknown", "cancelled"] },
    {
      field: "semanticState",
      words: ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"],
    },
  ]);
  assert.deepEqual(
    explanation.documentSchema.fields
      .filter(({ name }) => ["runtimeSessionId", "taskBindings", "liveness", "outcome", "semanticState"].includes(name))
      .map(({ name, required }) => ({ name, required })),
    [
      { name: "runtimeSessionId", required: true },
      { name: "taskBindings", required: true },
      { name: "liveness", required: true },
      { name: "outcome", required: true },
      { name: "semanticState", required: true },
    ],
  );
});

test("one EntityStore implementation upserts, gets, and lists every registered declaration kind", () => {
  const events: EntityEventV1[] = [],
    blobs = new Map<string, Uint8Array>(),
    store = createEntityStore({
      read: () => ({ schema: "canonical-event-stream/v1", revision: events.length, events }),
      readContentBlob: (sha256) => blobs.get(sha256) ?? null,
    }),
    append = (bundle: EntityUpsertBundle) => {
      events.push(bundle.event);
      for (const blob of bundle.blobs) blobs.set(blob.sha256, Buffer.from(blob.body));
    };

  append(upsert(store, "agent", agent, 1));
  append(upsert(store, "squad", squad, 2));
  append(upsert(store, "agent", { ...agent, name: "Terra Updated" }, 3));

  assert.equal(store.get<{ readonly name: string }>("agent", "terra")?.value.name, "Terra Updated");
  assert.deepEqual(
    store.list("agent").map(({ id }) => id),
    ["terra"],
  );
  assert.deepEqual(
    store.list("squad").map(({ id }) => id),
    ["core-squad"],
  );
  assert.equal(store.get("agent", "missing"), null);
});

test("Entity upsert rejects schema-invalid declarations and tampered declaration bundles", () => {
  const store = createEntityStore({
    read: () => ({ schema: "canonical-event-stream/v1", revision: 0, events: [] }),
    readContentBlob: () => null,
  });
  assert.throws(
    () => upsert(store, "agent", { ...agent, runtime_type: undefined }, 1),
    /missing required field "runtime_type"/u,
  );
  const bundle = upsert(store, "agent", agent, 1),
    tampered = [{ ...bundle.blobs[0], body: `${bundle.blobs[0].body} ` }];
  assert.throws(() => assertEntityUpsertInputs(bundle.event, bundle.plan, tampered), /declaration blob must be exact/u);
});

test("entity_upsert receipt detail is closed and registered", () => {
  const receipt = {
    outcome: "applied",
    opId: "op-agent-terra-1",
    revision: 1,
    evidence: "event-object:op-agent-terra-1",
    visibility: "center",
    proof: {
      committedRevision: 1,
      appliedCut: 1,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
    detail: {
      kind: "entity_upsert",
      entityKind: "agent",
      entityId: "terra",
      schemaId: "agent-declaration/v1",
      path: "agents/terra.json",
    },
  } as const;
  assert.deepEqual(validateWriteReceipt(receipt), []);
  assert.match(
    validateWriteReceipt({ ...receipt, detail: { ...receipt.detail, commandClass: "repo-write" } }).join("\n"),
    /registered receipt domain/u,
  );
});

function upsert(
  store: ReturnType<typeof createEntityStore>,
  entityKind: string,
  entity: unknown,
  workspaceRevision: number,
): EntityUpsertBundle {
  return store.upsert({
    entityKind,
    entity,
    eventId: `event-${entityKind}-${workspaceRevision}`,
    opId: `op-${entityKind}-${workspaceRevision}`,
    workspaceRevision,
    actor,
    source: "local",
    occurredAt: "2026-08-25T00:00:00.000Z",
  });
}
