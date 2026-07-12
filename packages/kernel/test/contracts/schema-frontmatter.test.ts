// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Schema } from "effect";
import { DecisionPackageSchema, EntityRelationsSchema, FactRecordSchema, TaskFrontmatterSchema } from "../../src/schemas/registry.ts";

const validFixtureUrl = new URL("../../fixtures/schemas/task-frontmatter/valid.json", import.meta.url);
const validDecisionFixtureUrl = new URL("../../fixtures/schemas/decision-package/valid.json", import.meta.url);
const invalidDecisionFixtureUrl = new URL("../../fixtures/schemas/decision-package/invalid.json", import.meta.url);
const validEntityRelationsFixtureUrl = new URL("../../fixtures/schemas/entity-relations/valid.json", import.meta.url);
const invalidEntityRelationsFixtureUrl = new URL("../../fixtures/schemas/entity-relations/invalid.json", import.meta.url);
const validFactRecordFixtureUrl = new URL("../../fixtures/schemas/fact-record/valid.json", import.meta.url);
const invalidFactRecordFixtureUrl = new URL("../../fixtures/schemas/fact-record/invalid.json", import.meta.url);
const factRecordJsonSchemaUrl = new URL("../../schemas/json/fact-record.schema.json", import.meta.url);
const decisionJsonSchemaUrl = new URL("../../schemas/json/decision-package.schema.json", import.meta.url);
const entityRelationsJsonSchemaUrl = new URL("../../schemas/json/entity-relations.schema.json", import.meta.url);

test("task frontmatter schema decodes and encodes the valid fixture", async () => {
  const fixture = JSON.parse(await readFile(validFixtureUrl, "utf8")) as unknown;
  const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)(fixture);
  const encoded = Schema.encodeSync(TaskFrontmatterSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("task frontmatter schema requires provenance with a known runtime", async () => {
  const fixture = await readJson(validFixtureUrl) as Record<string, unknown>;

  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({
    ...fixture,
    provenance: []
  }));
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({
    ...fixture,
    provenance: [{ runtime: "shell", sessionId: "human-cli-1783036800000", boundAt: "2026-06-11T00:00:00.000Z" }]
  }));
});

test("task frontmatter schema accepts optional metadata and rejects invalid values", async () => {
  const fixture = await readJson(validFixtureUrl) as Record<string, unknown>;
  const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)(fixture);

  assert.equal(decoded.workKind, "feat");
  assert.equal(decoded.riskTier, "high");
  assert.equal(decoded.urgency, "medium");
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({ ...fixture, workKind: "feature" }));
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({ ...fixture, riskTier: "urgent" }));
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({ ...fixture, urgency: "soon" }));
});

test("decision package schema decodes and encodes the valid fixture", async () => {
  const fixture = await readJson(validDecisionFixtureUrl);
  const decoded = Schema.decodeUnknownSync(DecisionPackageSchema)(fixture);
  const encoded = Schema.encodeSync(DecisionPackageSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("entity relations schema decodes and encodes the valid fixture", async () => {
  const fixture = await readJson(validEntityRelationsFixtureUrl);
  const decoded = Schema.decodeUnknownSync(EntityRelationsSchema)(fixture);
  const encoded = Schema.encodeSync(EntityRelationsSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("fact record schema requires memory classification fields", async () => {
  const validFixture = await readJson(validFactRecordFixtureUrl);
  const missingMemoryClass = await readJson(invalidFactRecordFixtureUrl);
  const decoded = Schema.decodeUnknownSync(FactRecordSchema)(validFixture);
  const encoded = Schema.encodeSync(FactRecordSchema)(decoded);

  assert.deepEqual(encoded, validFixture);
  assert.throws(() => Schema.decodeUnknownSync(FactRecordSchema)(missingMemoryClass));
});

test("decision package schema rejects contract-critical invalid fixtures", async () => {
  const emptyRejected = await readJson(invalidDecisionFixtureUrl);
  const base = await readJson(validDecisionFixtureUrl) as Record<string, any>;

  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)(emptyRejected));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({ ...base, state: "accepted" }));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({
    ...base,
    arbiter: base.proposedBy
  }));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({
    ...base,
    rejected: [{ id: "RJ3", text: "A rejected alternative without a rationale.", why_not: "   " }]
  }));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({
    ...base,
    provenance: [{ runtime: "claude-code", sessionId: "session-without-bound-at" }]
  }));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({
    ...base,
    provenance: [{ runtime: "shell", sessionId: "session", boundAt: "2026-07-03T00:00:00.000Z" }]
  }));
});

test("decision package content pins are optional for legacy records and validated when present", async () => {
  const legacy = await readJson(validDecisionFixtureUrl) as Record<string, any>;
  const decodedLegacy = Schema.decodeUnknownSync(DecisionPackageSchema)(legacy);
  assert.equal(decodedLegacy.contentPins, undefined);

  const pin = {
    action: "accept",
    state: "active",
    decidedAt: "2026-07-11T00:01:00.000Z",
    arbiter: { kind: "human", id: "zeyuli" },
    canonicalization: "decision-content/v1",
    digest: "sha256:e216d18ccaa40138e579485bafaa107c8a3cc1a47b995b7c6bb8c9507ef5c4a2"
  };
  assert.doesNotThrow(() => Schema.decodeUnknownSync(DecisionPackageSchema)({ ...legacy, contentPins: [pin] }));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({
    ...legacy,
    contentPins: [{ ...pin, digest: "sha256:not-a-digest" }]
  }));
  assert.throws(() => Schema.decodeUnknownSync(DecisionPackageSchema)({
    ...legacy,
    contentPins: [{ ...pin, state: "retired" }]
  }));
});

test("entity relations schema rejects contract-critical invalid fixtures", async () => {
  const invalidEndpoint = await readJson(invalidEntityRelationsFixtureUrl);
  const base = await readJson(validEntityRelationsFixtureUrl) as Record<string, any>;
  const [relation] = base.relations as Array<Record<string, unknown>>;

  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)(invalidEndpoint));
  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)({
    ...base,
    host: "decision/dec_OTHER"
  }));
  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)({
    ...base,
    relations: [
      relation,
      { ...relation, strength: "weak", rationale: "Same canonical edge with different mutable attributes." }
    ]
  }));
  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)({
    ...base,
    relations: [{ ...relation, rationale: "   " }]
  }));
  const { rationale: _rationale, ...strongRelationWithoutRationale } = relation;
  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)({
    ...base,
    relations: [strongRelationWithoutRationale]
  }));
  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)({
    ...base,
    relations: [{ ...relation, relation_id: "rel_0000000000000000" }]
  }));
});

test("decision package JSON schema is closed against evidence_refs drift", async () => {
  const jsonSchema = await readJson(decisionJsonSchemaUrl) as {
    readonly additionalProperties?: boolean;
    readonly properties?: Record<string, unknown>;
    readonly $defs?: Record<string, { readonly additionalProperties?: boolean }>;
  };

  assert.equal(jsonSchema.additionalProperties, false);
  assert.equal(Object.prototype.hasOwnProperty.call(jsonSchema.properties, "evidence_refs"), false);
  assert.equal(jsonSchema.$defs?.relationRecord.additionalProperties, false);
  assert.deepEqual((jsonSchema.$defs?.relationRecord as any).properties.type.enum, [
    "supports",
    "supersedes",
    "refines",
    "narrows",
    "derives",
    "blocks",
    "relates",
    "implements",
    "depends-on",
    "produces",
    "evidences",
    "evidenced-by",
    "refutes",
    "invalidated-by",
    "supersedes-fact"
  ]);
});

test("entity relations JSON schema is closed and keeps facts owner-qualified", async () => {
  const jsonSchema = await readJson(entityRelationsJsonSchemaUrl) as {
    readonly additionalProperties?: boolean;
    readonly properties?: Record<string, unknown>;
    readonly $defs?: Record<string, {
      readonly additionalProperties?: boolean;
      readonly pattern?: string;
      readonly properties?: Record<string, unknown>;
    }>;
  };

  assert.equal(jsonSchema.additionalProperties, false);
  assert.equal(jsonSchema.$defs?.relationRecord.additionalProperties, false);
  assert.match(jsonSchema.$defs?.entityRef.pattern ?? "", /fact\//u);
  assert.doesNotMatch(jsonSchema.$defs?.entityRef.pattern ?? "", /fact\/\[A-Za-z0-9_-\]\+\?/u);
});

test("fact record JSON schema publishes memory classification fields", async () => {
  const jsonSchema = await readJson(factRecordJsonSchemaUrl) as {
    readonly additionalProperties?: boolean;
    readonly required?: ReadonlyArray<string>;
    readonly properties?: Record<string, {
      readonly enum?: ReadonlyArray<string>;
      readonly type?: string;
      readonly items?: { readonly enum?: ReadonlyArray<string> };
    }>;
  };

  assert.equal(jsonSchema.additionalProperties, false);
  assert.equal(jsonSchema.required?.includes("memoryClass"), true);
  assert.equal(jsonSchema.required?.includes("memoryTags"), true);
  assert.deepEqual(jsonSchema.properties?.memoryClass?.enum, ["semantic", "episodic", "procedural"]);
  assert.equal(jsonSchema.properties?.memoryTags?.type, "array");
  assert.deepEqual(jsonSchema.properties?.memoryTags?.items?.enum, [
    "episode",
    "procedural",
    "tool_memory",
    "pattern",
    "task_skill",
    "abstract_rule",
    "other"
  ]);
});

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}
