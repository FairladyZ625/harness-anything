// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  actorAxesBindingCoreDigestV2,
  type ActorAxesBindingCoreV2
} from "../../src/integrity/actor-axes-binding-integrity-v2.ts";
import { encodeCanonicalCbor } from "../../src/integrity/canonical-cbor.ts";
import {
  semanticMutationSetDigestV2,
  semanticMutationWireV2,
  type SemanticMutationSetV2,
  type SemanticMutationV2
} from "../../src/integrity/semantic-mutation-integrity-v2.ts";
import { decodeUnionAttributionEventBody } from "../../src/local/attribution-event-source.ts";
import {
  materializeAttributionProjectionFromEvents,
  readAttributionProjection
} from "../../src/projection/sqlite-attribution-projection.ts";
import { queryTaskProjectionRows } from "../../src/projection/sqlite-projection-store.ts";
import { readTaskProjection, rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";
import {
  attributionEventCompleteness,
  canonicalAttributionEventDigestV2,
  physicalChangeSetDigestV2,
  type AttributionEventV2,
  type PhysicalChangeV2
} from "../../src/schemas/attribution-event-union.ts";
import { makeLocalAuthorityAttributionEventV2Log } from "../../src/store/authority-attribution-event-v2-log.ts";
import { withTempStore } from "./helpers.ts";

const digestA = "11".repeat(32);
const digestB = "22".repeat(32);

test("strict union decoder keeps v1 host-only or legacy-partial and rejects unknown fields", () => {
  const hostOnly = decodeUnionAttributionEventBody(`${JSON.stringify(v1Event())}\n`);
  assert.equal(attributionEventCompleteness(hostOnly), "host-only");
  assert.equal(hostOnly.schema, "attribution-event/v1");

  const legacyPartial = decodeUnionAttributionEventBody(`${JSON.stringify(v1Event({
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: digestA,
      semanticMutationSetDigest: digestB,
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: digestA,
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    }
  }))}\n`);
  assert.equal(attributionEventCompleteness(legacyPartial), "legacy-partial");
  assert.notEqual(attributionEventCompleteness(legacyPartial), "complete");

  assert.throws(
    () => decodeUnionAttributionEventBody(`${JSON.stringify({ ...v1Event(), inferredMutations: [] })}\n`),
    /unknown or missing fields/u
  );
});

test("v2 decoder verifies every digest and projects exact event mutations", () => {
  const event = v2Event([
    mutation("fact", "fact/task_T/F-1", "create"),
    mutation("relation", "relation/rel_0123456789abcdef", "create")
  ]);
  const decoded = decodeUnionAttributionEventBody(`${JSON.stringify(event)}\n`);
  assert.equal(decoded.schema, "attribution-event/v2");
  assert.equal(attributionEventCompleteness(decoded), "complete");
  assert.deepEqual(decoded.mutationSet.mutations.map((entry) => entry.entity.canonicalRef).sort(), [
    "fact/task_T/F-1",
    "relation/rel_0123456789abcdef"
  ]);

  for (const [field, code] of [
    ["semanticMutationSetDigest", /SEMANTIC_MUTATION_SET_DIGEST_MISMATCH/u],
    ["actorAxesBindingDigest", /ACTOR_AXES_BINDING_DIGEST_MISMATCH/u],
    ["changeSetDigest", /PHYSICAL_CHANGE_SET_DIGEST_MISMATCH/u],
    ["canonicalEventDigest", /CANONICAL_EVENT_DIGEST_MISMATCH/u]
  ] as const) {
    assert.throws(
      () => decodeUnionAttributionEventBody(`${JSON.stringify({ ...event, [field]: digestA })}\n`),
      code
    );
  }
  assert.throws(
    () => decodeUnionAttributionEventBody(`${JSON.stringify({ ...event, extra: true })}\n`),
    /unknown or missing fields/u
  );
});

test("union event headers and mutation join rebuild identically after SQLite deletion", () => {
  withTempStore((rootDir) => {
    const event = v2Event([
      mutation("fact", "fact/task_T/F-1", "create"),
      mutation("relation", "relation/rel_0123456789abcdef", "create")
    ]);
    makeLocalAuthorityAttributionEventV2Log(rootDir).ensure(event);

    rebuildTaskProjection({ rootDir });
    const before = readAttributionProjection(rootDir);
    assert.equal(before.length, 2);
    assert.equal(before.every((row) => row.eventSchemaVersion === 2 && row.completeness === "complete"), true);
    assert.equal(before.every((row) => row.legacyHostRef === null), true);
    assert.deepEqual(new Set(before.map((row) => row.entityKind)), new Set(["fact", "relation"]));

    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    rmSync(projectionPath, { force: true });
    assert.equal(existsSync(projectionPath), false);
    rebuildTaskProjection({ rootDir });
    assert.deepEqual(readAttributionProjection(rootDir), before);
  });
});

test("materializer applies V2-over-V1 precedence even when called with both versions", () => {
  withTempStore((rootDir) => {
    const taskId = "task_T";
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      `task_id: ${taskId}`,
      "title: Materializer precedence",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: active",
      "  ref: ",
      "  titleSnapshot: Materializer precedence",
      "  url: ",
      "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
      "  bindingFingerprint: sha256:fixture",
      "packageDisposition: active",
      "---",
      ""
    ].join("\n"), "utf8");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const v2 = v2Event([mutation("fact", "fact/task_T/F-1", "create")]);
    const v1 = decodeUnionAttributionEventBody(`${JSON.stringify(v1Event({
      eventId: v2.eventId,
      opId: v2.opId
    }))}\n`);

    const rows = materializeAttributionProjectionFromEvents(projectionPath, [v1, v2]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.eventSchemaVersion, 2);
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM attribution_events").get() as { count: number }).count), 0);
      assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM attribution_event_headers").get() as { count: number }).count), 1);
    } finally {
      db.close();
    }
  });
});

test("incremental materializer replaces a projected V1 shadow when durable V2 appears", () => {
  withTempStore((rootDir) => {
    const taskId = "task_T";
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    const eventsRoot = path.join(rootDir, "harness/attribution-events");
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(eventsRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      `task_id: ${taskId}`,
      "title: Incremental precedence",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: active",
      "  ref: ",
      "  titleSnapshot: Incremental precedence",
      "  url: ",
      "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
      "  bindingFingerprint: sha256:fixture",
      "packageDisposition: active",
      "---",
      ""
    ].join("\n"), "utf8");
    const v2 = v2Event([mutation("fact", "fact/task_T/F-1", "create")]);
    writeFileSync(path.join(eventsRoot, "legacy-shadow.jsonl"), `${JSON.stringify(v1Event({
      eventId: v2.eventId,
      opId: v2.opId
    }))}\n`, "utf8");
    rebuildTaskProjection({ rootDir });
    assert.equal(readAttributionProjection(rootDir)[0]?.eventSchemaVersion, 1);

    makeLocalAuthorityAttributionEventV2Log(rootDir).ensure(v2);
    readTaskProjection({ rootDir });
    const rows = readAttributionProjection(rootDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.eventSchemaVersion, 2);
    assert.equal(rows[0]?.opId, v2.opId);
  });
});

test("attribution materialization writes each entity summary without an unresolved intermediate state", () => {
  withTempStore((rootDir) => {
    const taskId = "task_T";
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      `task_id: ${taskId}`,
      "title: Set based attribution",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: active",
      "  ref: ",
      "  titleSnapshot: Set based attribution",
      "  url: ",
      "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
      "  bindingFingerprint: sha256:fixture",
      "packageDisposition: active",
      "---",
      ""
    ].join("\n"), "utf8");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.exec(`
        CREATE TRIGGER reject_unresolved_attribution_rewrite
        BEFORE INSERT ON entity_attribution_summary
        WHEN NEW.entity_kind = 'task'
          AND NEW.entity_id = '${taskId}'
          AND NEW.completeness = 'unresolved'
        BEGIN SELECT RAISE(ABORT, 'attribution summary used an unresolved intermediate state'); END
      `);
    } finally {
      db.close();
    }

    const event = decodeUnionAttributionEventBody(`${JSON.stringify(v1Event())}\n`);
    materializeAttributionProjectionFromEvents(projectionPath, [event]);

    const [task] = queryTaskProjectionRows(projectionPath, {});
    assert.equal(task?.attribution.latestActor?.principal.personId, "person_zeyu");
  });
});

test("entity attribution is stored once in the unified summary projection", () => {
  withTempStore((rootDir) => {
    const taskId = "task_T";
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    const eventsRoot = path.join(rootDir, "harness/attribution-events");
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(eventsRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      `task_id: ${taskId}`,
      "title: Unified attribution",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: active",
      "  ref: ",
      "  titleSnapshot: Unified attribution",
      "  url: ",
      "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
      "  bindingFingerprint: sha256:fixture",
      "packageDisposition: active",
      "---",
      ""
    ].join("\n"), "utf8");
    writeFileSync(path.join(eventsRoot, "legacy-op.jsonl"), `${JSON.stringify(v1Event())}\n`, "utf8");

    rebuildTaskProjection({ rootDir });

    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      const taskColumns = db.prepare("PRAGMA table_info(task_projection)").all() as Array<{ readonly name: string }>;
      assert.equal(taskColumns.some((column) => column.name === "attribution_json"), false);
      assert.deepEqual({ ...db.prepare(`
        SELECT entity_kind, entity_id, trail_count, completeness
        FROM entity_attribution_summary
      `).get() }, {
        entity_kind: "task",
        entity_id: taskId,
        trail_count: 1,
        completeness: "host-only"
      });
    } finally {
      db.close();
    }
    const [task] = queryTaskProjectionRows(projectionPath, {});
    assert.equal(task?.attribution.latestActor?.principal.personId, "person_zeyu");
  });
});

function v1Event(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: "attribution-event/v1",
    eventId: "attribution:legacy-op",
    opId: "legacy-op",
    journalRecordSchema: "write-journal/v2",
    entityId: "task/task_T",
    kind: "doc_write",
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: null
    },
    principalSource: { kind: "migration", evidenceRef: "legacy-fixture" },
    executorSource: "none",
    at: "2026-07-13T00:00:00.000Z",
    recordedAt: "2026-07-13T00:00:00.000Z",
    payloadHash: digestA,
    payloadRef: { path: "payloads/legacy-op.json", sha256: digestA },
    ...extra
  };
}

function v2Event(mutations: ReadonlyArray<SemanticMutationV2>): AttributionEventV2 {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [...mutations].sort((left, right) => Buffer.compare(
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
    ))
  };
  const actorAxesBinding: ActorAxesBindingCoreV2 = {
    bindingId: "binding-1",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent-codex",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    schemaTuple: {
      wire: 2,
      event: 2,
      receipt: 2,
      digest: 2,
      policy: 1,
      commandRegistry: 1,
      entityRegistry: 1,
      mutationRegistry: 1,
      localState: 1,
      applyJournal: 1
    }
  };
  const physicalChanges: ReadonlyArray<PhysicalChangeV2> = [{
    path: "tasks/task_T/facts.md",
    beforeDigest: digestA,
    afterDigest: digestB
  }];
  const withoutEventDigest: Omit<AttributionEventV2, "canonicalEventDigest"> = {
    schema: "attribution-event/v2",
    eventId: "attribution:v2-op",
    workspaceId: "workspace-1",
    opId: "v2-op",
    revision: 1,
    commitSha: "commit-v2",
    previousCommit: "commit-v1",
    outcome: "COMMITTED",
    occurredAt: "2026-07-13T00:00:01.000Z",
    recordedAt: "2026-07-13T00:00:01.100Z",
    actorAxesBinding,
    semanticRequestDigest: "33".repeat(32),
    mutationSet,
    semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
    actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
    physicalChanges,
    changeSetDigest: hex(physicalChangeSetDigestV2(physicalChanges))
  };
  return {
    ...withoutEventDigest,
    canonicalEventDigest: hex(canonicalAttributionEventDigestV2(withoutEventDigest))
  };
}

function mutation(entityKind: string, canonicalRef: string, action: string): SemanticMutationV2 {
  return {
    entity: { registryVersion: 1, entityKind, canonicalRef },
    action: { registryVersion: 1, action }
  };
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
