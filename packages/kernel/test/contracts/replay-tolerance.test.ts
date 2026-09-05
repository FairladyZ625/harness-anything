// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveRelationId } from "../../src/domain/entity-relation.ts";
import { parseEntityJsonSchema, validateEntityJsonSchema } from "../../src/domain/entity-json-schema.ts";
import { interpretEntityProjection } from "../../src/domain/entity-kind-projection.ts";
import { requireEntityKindContract } from "../../src/domain/entity-kind-registry.ts";
import {
  compileRelationCreatedEvent,
  reduceRelationEntity,
  validateCurrentRelationEvent,
  validateRelationEvent,
} from "../../src/domain/relation-event.ts";
import { createScheduleV1, validateScheduleDefinitionV1, scheduleDefinition } from "../../src/domain/schedule.ts";
import { validateRepositorySettings, repositorySettings } from "../../src/domain/settings.ts";

// Projection replay re-reads declarations the writer already accepted under the schema of their day. Each case
// below is a real stored shape that latched a repository on the 2026-09-05 rebuild (data-shape), paired with the
// writer-side check that must stay strict so tolerance never leaks onto the accept path.

const actor = { principal: { personId: "person-replay" }, executor: null } as const;

test("replay: a 2026-08-31 Settings declaration (no reviewIndependence, no walFlush) still projects", () => {
  const legacy = {
    schema: "settings/v1",
    settingsId: "repository",
    defaultVertical: "software/coding",
    defaultPreset: "standard-task",
    defaultProfile: "baseline",
    scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
  };
  assert.deepEqual(validateRepositorySettings(legacy), []);
  const projected = interpretEntityProjection(requireEntityKindContract("settings"), legacy, 3, "events/x.json");
  assert.equal(projected?.id, "repository");
  const read = repositorySettings(legacy as never);
  assert.equal(read.reviewIndependence, "execution");
  assert.equal(read.walFlush.adaptive, true);
});

test("replay: a 2026-08-29 Schedule declaration whose target still carries cwd projects; the writer rejects it", () => {
  const schedule = createScheduleV1({
      scheduleId: "antientropy-sweep",
      name: "反熵周期轻扫",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 43_200_000, anchorAt: "2026-08-29T02:34:18.719Z" },
        target: { kind: "agent", agentId: "ae-discrimination", runtimeInstanceId: "test-codex-sol" },
        mission: "周期反熵轻扫。",
      },
      actor,
      occurredAt: "2026-08-29T02:34:18.719Z",
    }),
    legacyBlob = {
      ...scheduleDefinition(schedule),
      spec: { ...schedule.spec, target: { ...schedule.spec.target, cwd: ".worktrees/antientropy-0829b" } },
    },
    legacyRow = { ...schedule, spec: legacyBlob.spec },
    contract = requireEntityKindContract("schedule");
  // replay tolerates the removed field
  assert.deepEqual(validateScheduleDefinitionV1(legacyBlob, true), []);
  assert.equal(interpretEntityProjection(contract, legacyRow, 42_614, "events/c7/x.json")?.id, "antientropy-sweep");
  // the writer does not
  assert.match(validateScheduleDefinitionV1(legacyBlob).join("; "), /"cwd" is unknown/u);
  assert.throws(() => parseEntityJsonSchema(contract.schema, legacyRow), /"cwd" is unknown/u);
});

test("replay: a relation_created facet with strength and no targetObservedVersion reduces; the writer rejects it", () => {
  const identity = {
      source: "relation/rel_1111111111111111",
      target: "decision/dec_RELATION_TARGET",
      type: "relates" as const,
      direction: "directed" as const,
    },
    created = compileRelationCreatedEvent({
      record: {
        relation_id: deriveRelationId(identity),
        ...identity,
        origin: "declared",
        state: "active",
        rationale: "Replay tolerance contract.",
        targetObservedVersion: 1,
      },
      actor,
      source: "local",
      opId: "relation-replay-legacy",
      occurredAt: "2026-08-20T00:00:00.000Z",
      workspaceRevision: 21,
    }),
    { targetObservedVersion: _dropped, ...facet } = created.payload.relation,
    legacy = { ...created, payload: { ...created.payload, relation: { ...facet, strength: "weak" } } } as never;
  assert.deepEqual(validateRelationEvent(legacy), []);
  const entity = reduceRelationEntity(null, legacy);
  assert.equal(entity.source, identity.source);
  assert.ok(validateCurrentRelationEvent(legacy).length > 0);
});

test("replay: unknown fields are tolerated inside arrays too, and only when asked", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ReplayArray/v1",
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  } as const;
  const value = { items: [{ id: "a", legacy: true }] };
  assert.equal(validateEntityJsonSchema(schema as never, value, "fixture", { allowUnknownFields: true }).length, 0);
  assert.match(validateEntityJsonSchema(schema as never, value, "fixture").join("; "), /"legacy" is unknown/u);
});
