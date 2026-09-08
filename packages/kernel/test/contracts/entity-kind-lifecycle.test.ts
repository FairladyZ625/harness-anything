// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createEntityKindLifecycle, type EntityJsonObjectSchema } from "../../src/index.ts";

const schemaV1: EntityJsonObjectSchema = {
  type: "object",
  properties: { status: { type: "string", enum: ["draft", "published"] } },
  required: ["status"],
  additionalProperties: false,
};
const schemaV2: EntityJsonObjectSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["draft", "published", "archived"] },
    score: { type: "integer", minimum: 0 },
  },
  required: ["status"],
  additionalProperties: false,
};

test("generic kind lifecycle persists schema pins through v2, rename, and archive", () => {
  let counter = 0;
  const lifecycle = createEntityKindLifecycle({
    mint: () => (++counter).toString(16).padStart(32, "0"),
  });
  const created = lifecycle.dispatch({
    kind: "entity-kind-create",
    name: "Runbook",
    schema: schemaV1,
    expectedRevision: 0,
  });
  assert.equal(created.type, "kind_created");
  const kindId = created.payload.kindId as `entity-kind/KND-${string}`;
  assert.match(kindId, /^entity-kind\/KND-[0-9a-f]{32}$/u);
  const first = lifecycle.dispatch({
    kind: "entity-import",
    kindId,
    title: "First",
    attributes: { status: "draft" },
    expectedRevision: 1,
  });
  const firstId = first.payload.entityId as `entity/RES-${string}`;
  assert.equal(first.payload.kindVersion, 1);
  lifecycle.dispatch({ kind: "entity-kind-schema-publish", kindId, schema: schemaV2, expectedRevision: 2 });
  const second = lifecycle.dispatch({
    kind: "entity-import",
    kindId,
    title: "Second",
    attributes: { status: "published", score: 4 },
    expectedRevision: 3,
  });
  assert.equal(second.payload.kindVersion, 2);
  assert.equal(lifecycle.readEntity(firstId)?.kindVersion, 1);
  assert.equal(lifecycle.readEntity(second.payload.entityId as `entity/RES-${string}`)?.kindVersion, 2);
  assert.throws(
    () =>
      lifecycle.dispatch({
        kind: "entity-import",
        kindId,
        title: "Bad",
        attributes: { status: "published", score: "4" },
        expectedRevision: 4,
      }),
    (error: unknown) => (error as { code?: string }).code === "invalid_attributes",
  );
  lifecycle.dispatch({ kind: "entity-kind-rename", kindId, name: "Playbook", expectedRevision: 4 });
  assert.equal(lifecycle.readKind(kindId)?.name, "Playbook");
  assert.equal(lifecycle.readEntity(firstId)?.kindId, kindId);
  lifecycle.dispatch({ kind: "entity-kind-archive", kindId, expectedRevision: 5 });
  assert.equal(lifecycle.readKind(kindId)?.archived, true);
  assert.throws(
    () =>
      lifecycle.dispatch({
        kind: "entity-import",
        kindId,
        title: "Nope",
        attributes: { status: "draft" },
        expectedRevision: 6,
      }),
    (error: unknown) => (error as { code?: string }).code === "kind_archived",
  );
  assert.throws(
    () => lifecycle.dispatch({ kind: "entity-kind-rename", kindId, name: "Nope", expectedRevision: 5 }),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
  const replayed = createEntityKindLifecycle({ events: lifecycle.events() });
  assert.deepEqual(replayed.readKind(kindId), lifecycle.readKind(kindId));
  assert.deepEqual(replayed.readEntity(firstId), lifecycle.readEntity(firstId));
  assert.equal(replayed.events().length, 6);
});
