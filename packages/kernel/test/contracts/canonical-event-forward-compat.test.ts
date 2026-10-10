// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  completionGenerationFixtures,
  convertFrozenCompletionSample,
} from "../../../../tools/gates/completion-generation-fixtures.mjs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { stableStringify } from "../../src/integrity/stable-hash.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  canonicalEventSchemas,
  normalizePersistedCanonicalEvent,
  parseCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../../src/domain/doc-sync.contract.ts";
import { eventShapeMigrations, type EventShapeCut } from "../../src/store/event-shape-migration.ts";
import { ownedContentForDeclarationEvent, type EntityUpsertEventV1 } from "../../src/domain/entity-event.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync-types.ts";
import { validateTaskV2 } from "../../src/domain/task.ts";
import { sameActorIdentity, sameWriteSource, serializeEventEnvelope } from "../../src/domain/write-chain.contract.ts";

const actor = { principal: { personId: "person-fixture" }, executor: { kind: "agent" as const, id: "codex" } };
const taskCreated = {
  schema: "task-event/v1" as const,
  eventId: "event-forward-compat",
  workspaceRevision: 1,
  opId: "op-forward-compat",
  taskId: "task-forward-compat",
  type: "task_created" as const,
  actor,
  source: "local" as const,
  occurredAt: "2026-08-21T00:00:00.000Z",
  payload: {
    task: {
      schema: "task/v2" as const,
      taskId: "task-forward-compat",
      title: "Forward compatible task",
      taskClass: "standard" as const,
      status: "planned" as const,
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation" as const,
      iteration: 0 as const,
      pinned: false,
      createdBy: actor,
      completionGateIds: ["ci"],
      presetSnapshotDigest: null,
    },
  },
};

test("Task/v2 readers ignore a field that current writers do not know", () => {
  const future = {
    ...taskCreated,
    payload: { task: { ...taskCreated.payload.task, futureOptionalField: true } },
  };
  const bytes = serializeEventEnvelope(future);

  assert.deepEqual(parseCanonicalEvent(bytes), future);
  assert.match(validateCurrentCanonicalEvent(future).join("\n"), /unknown/u);
});

test("Task/v2 provenance readers ignore additions without relaxing required fields", () => {
  const provenance = {
      runtime: "codex",
      sessionId: "session-fixture",
      transcriptReachability: "by_session_id" as const,
      boundAt: taskCreated.occurredAt,
    },
    future = {
      ...taskCreated.payload.task,
      provenance: [{ ...provenance, futureOptionalField: true }],
    },
    { boundAt: _boundAt, ...missingBoundAt } = provenance;
  void _boundAt;

  assert.deepEqual(validateTaskV2(future, true), []);
  assert.match(
    validateTaskV2(future)
      .map(({ message }) => message)
      .join("\n"),
    /provenance/u,
  );
  assert.match(
    validateTaskV2({ ...taskCreated.payload.task, provenance: [missingBoundAt] }, true)
      .map(({ message }) => message)
      .join("\n"),
    /provenance/u,
  );
});

test("cold replay restates immutable Task/v1 payloads as explicit Task/v2 state", () => {
  const persisted = structuredClone(taskCreated) as unknown as Record<string, unknown>,
    payload = persisted.payload as Record<string, unknown>,
    task = payload.task as Record<string, unknown>;
  task.schema = "task/v1";
  delete task.pinned;
  delete task.packageDisposition;
  const normalized = normalizePersistedCanonicalEvent(persisted as never) as unknown as typeof taskCreated & {
    readonly payload: { readonly task: { readonly packageDisposition: string } };
  };

  assert.equal(normalized.payload.task.schema, "task/v2");
  assert.equal(normalized.payload.task.pinned, false);
  assert.equal(normalized.payload.task.packageDisposition, "active");
});

test("semantic actor and source equality ignores additions but not known-axis changes", () => {
  assert.equal(sameActorIdentity({ ...actor, futureOptionalField: true }, actor), true);
  assert.equal(sameActorIdentity({ ...actor, principal: { personId: "someone-else" } }, actor), false);
  // watch_session remains readable only as immutable historical event identity;
  // current command normalization rejects it after automatic ingestion retired.
  const source = {
    kind: "watch_session" as const,
    sessionId: "session-1",
    path: "context/input.md",
    fingerprint: "a".repeat(64),
  };
  assert.equal(sameWriteSource({ ...source, futureOptionalField: true }, source), true);
  assert.equal(sameWriteSource({ ...source, path: "context/other.md" }, source), false);
});

test("the retired agent entity envelope is parse-only", () => {
  const pathName = path.resolve(
      import.meta.dirname,
      "../../fixtures/canonical-events/agent-entity-event-v1/accepted.json",
    ),
    body = readFileSync(pathName, "utf8"),
    event = JSON.parse(body) as unknown;
  assert.deepEqual(parseCanonicalEvent(body), event);
  assert.match(validateCurrentCanonicalEvent(event).join("\n"), /not current/u);
  assert.equal(
    Object.hasOwn(canonicalEventSchemas.find(({ schema }) => schema === "agent-entity-event/v1")!, "validateCurrent"),
    false,
  );
});

test("every canonical reader ignores an unknown field at every frozen object boundary", () => {
  const fixtureRoot = path.resolve(import.meta.dirname, "../../fixtures/canonical-events");
  let probes = 0;
  for (const entry of canonicalEventSchemas) {
    const directory = path.join(fixtureRoot, entry.schema.replaceAll("/", "-"));
    for (const name of readdirSync(directory).filter((candidate) => candidate.endsWith(".json"))) {
      const file = path.join(directory, name),
        body = readFileSync(file, "utf8");
      const relative = path
        .relative(path.resolve(import.meta.dirname, "../../../.."), file)
        .split(path.sep)
        .join("/");
      // dec_5EC2631352B17EE2BF4979E37E: old completion samples enter the current reader only after offline conversion.
      const original: unknown = completionGenerationFixtures.has(relative)
        ? convertFrozenCompletionSample(body, relative)
        : JSON.parse(body);
      for (const objectPath of objectPaths(original)) {
        const candidate = structuredClone(original);
        objectAt(candidate, objectPath).__fixtureFutureField = true;
        assert.deepEqual(entry.validate(candidate), [], `${entry.schema}:${name}:$.${objectPath.join(".")}`);
        probes += 1;
      }
    }
  }
  assert.ok(probes > canonicalEventSchemas.length, "the probe must reach nested object fields");
});

type ObjectPath = readonly (string | number)[];

function objectPaths(value: unknown, current: ObjectPath = [], found: ObjectPath[] = []): ObjectPath[] {
  if (Array.isArray(value)) value.forEach((child, index) => objectPaths(child, [...current, index], found));
  else if (value !== null && typeof value === "object") {
    found.push(current);
    for (const [key, child] of Object.entries(value)) objectPaths(child, [...current, key], found);
  }
  return found;
}

function objectAt(value: unknown, objectPath: ObjectPath): Record<string, unknown> {
  let current = value;
  for (const segment of objectPath) {
    if (Array.isArray(current) && typeof segment === "number") current = current[segment];
    else if (current !== null && typeof current === "object" && typeof segment === "string")
      current = (current as Record<string, unknown>)[segment];
    else throw new Error(`fixture path does not resolve to an object: ${objectPath.join(".")}`);
  }
  if (current === null || typeof current !== "object" || Array.isArray(current))
    throw new Error(`fixture path is not an object: ${objectPath.join(".")}`);
  return current as Record<string, unknown>;
}
test("retired milestone and epic task classes stay readable but cannot become current writes", () => {
  for (const taskClass of ["milestone", "epic"]) {
    const historical = {
      ...taskCreated,
      payload: { ...taskCreated.payload, task: { ...taskCreated.payload.task, taskClass } },
    };
    assert.deepEqual(validateTaskV2(historical.payload.task, true), []);
    assert.deepEqual(
      validateTaskV2(historical.payload.task).map(({ message }) => message),
      [`retired taskClass ${taskClass}; restate it with ha task contract migrate --apply`],
    );
    assert.deepEqual(parseCanonicalEvent(serializeEventEnvelope(historical)).payload, historical.payload);
    assert.notEqual(validateCurrentCanonicalEvent(historical).length, 0);
  }
  const current = {
    ...taskCreated,
    payload: { ...taskCreated.payload, task: { ...taskCreated.payload.task, taskClass: "work" } },
  };
  assert.deepEqual(validateCurrentCanonicalEvent(current), []);
});

test("historical entity ownership gaps remain readable but cannot become current writes", () => {
  const raw = readFileSync(
    new URL(
      "../../fixtures/canonical-events/entity-event-v1/accepted-entity-upserted-ddcb7509cb2d.json",
      import.meta.url,
    ),
    "utf8",
  );
  const original = JSON.parse(raw);
  assert.equal(original.payload.ownedContent, undefined);
  assert.deepEqual(parseCanonicalEvent(raw), original);
  assert.notEqual(validateCurrentCanonicalEvent(original).length, 0);
  const historical = original as EntityUpsertEventV1;
  const migration = eventShapeMigrations["entity-owned-content-manifests-migrate"];
  const rewrite = migration.rewrite(historical as unknown as CanonicalEventV1, {} as EventShapeCut)!;
  assert.deepEqual(rewrite.event.payload.ownedContent, ownedContentForDeclarationEvent(historical));
  assert.deepEqual(rewrite.event.payload.declarationDocumentClaim, historical.payload.declarationDocumentClaim);
  assert.deepEqual(validateCurrentCanonicalEvent(rewrite.event), []);
  assert.equal(migration.rewrite(rewrite.event, {} as EventShapeCut), null);
  for (const type of ["entity_content_observed", "entity_updated"]) {
    assert.equal(migration.rewrite({ ...historical, type } as unknown as CanonicalEventV1, {} as EventShapeCut), null);
  }
  const invalid = {
    ...historical,
    payload: { ...historical.payload, ownedContent: null },
  } as unknown as CanonicalEventV1;
  assert.equal(migration.rewrite(invalid, {} as EventShapeCut), null);
  assert.notEqual(validateCurrentCanonicalEvent(invalid).length, 0);
});

test("historical artifact contract snapshots remain readable without inventing a current pin", () => {
  const raw = readFileSync(
      new URL("../../fixtures/canonical-events/entity-event-v1/accepted.json", import.meta.url),
      "utf8",
    ),
    original = JSON.parse(raw);
  assert.equal(original.payload.artifactContract.kindVersion, undefined);
  assert.deepEqual(parseCanonicalEvent(raw), original);
  assert.notEqual(validateCurrentCanonicalEvent(original).length, 0);
});

test("delegation audit additions remain read-only and required identity is still validated", () => {
  const event = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../fixtures/canonical-events/execution-delegation-event-v1/accepted.json"),
      "utf8",
    ),
  );
  for (const objectPath of objectPaths(event)) {
    const future = structuredClone(event);
    objectAt(future, objectPath).__fixtureFutureField = true;
    assert.deepEqual(parseCanonicalEvent(stableStringify(future) + "\n"), future);
    assert.ok(validateCurrentCanonicalEvent(future).length > 0);
  }
  const invalid = { ...event, payload: { operation: "issue" } };
  assert.throws(() => parseCanonicalEvent(serializeEventEnvelope(invalid)), /Invalid execution delegation/u);
  assert.ok(validateCurrentCanonicalEvent(invalid).length > 0);
});
