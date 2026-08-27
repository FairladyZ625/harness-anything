// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Schema } from "effect";
import { EntityRelationsSchema, TaskFrontmatterSchema } from "../../src/schemas/registry.ts";
import { DecisionEventSchema } from "../../src/schemas/decision-event.ts";

const validFixtureUrl = new URL("../../fixtures/schemas/task-frontmatter/valid.json", import.meta.url);
const validDecisionFixtureUrl = new URL("../../fixtures/schemas/decision-package/valid.json", import.meta.url);
const invalidDecisionFixtureUrl = new URL("../../fixtures/schemas/decision-package/invalid.json", import.meta.url);
const validEntityRelationsFixtureUrl = new URL("../../fixtures/schemas/entity-relations/valid.json", import.meta.url);
const invalidEntityRelationsFixtureUrl = new URL(
  "../../fixtures/schemas/entity-relations/invalid.json",
  import.meta.url,
);
const decisionJsonSchemaUrl = new URL("../../schemas/json/decision-package.schema.json", import.meta.url);
const entityRelationsJsonSchemaUrl = new URL("../../schemas/json/entity-relations.schema.json", import.meta.url);
const factEventJsonSchemaUrl = new URL("../../schemas/json/fact-event.schema.json", import.meta.url);

test("task frontmatter schema decodes and encodes the valid fixture", async () => {
  const fixture = JSON.parse(await readFile(validFixtureUrl, "utf8")) as unknown;
  const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)(fixture);
  const encoded = Schema.encodeSync(TaskFrontmatterSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("task frontmatter schema requires provenance with a known runtime", async () => {
  const fixture = (await readJson(validFixtureUrl)) as Record<string, unknown>;

  assert.throws(() =>
    Schema.decodeUnknownSync(TaskFrontmatterSchema)({
      ...fixture,
      provenance: [],
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(TaskFrontmatterSchema)({
      ...fixture,
      provenance: [{ runtime: "shell", sessionId: "human-cli-1783036800000", boundAt: "2026-06-11T00:00:00.000Z" }],
    }),
  );
});

test("task frontmatter schema accepts optional metadata and rejects invalid values", async () => {
  const fixture = (await readJson(validFixtureUrl)) as Record<string, unknown>;
  const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)(fixture);

  assert.equal(decoded.workKind, "feat");
  assert.equal(decoded.riskTier, "high");
  assert.equal(decoded.urgency, "medium");
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({ ...fixture, workKind: "feature" }));
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({ ...fixture, riskTier: "urgent" }));
  assert.throws(() => Schema.decodeUnknownSync(TaskFrontmatterSchema)({ ...fixture, urgency: "soon" }));
});

test("Decision event schema decodes and encodes the valid fixture", async () => {
  const fixture = await readJson(validDecisionFixtureUrl);
  const decoded = Schema.decodeUnknownSync(DecisionEventSchema)(fixture);
  const encoded = Schema.encodeSync(DecisionEventSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("entity relations schema decodes and encodes the valid fixture", async () => {
  const fixture = await readJson(validEntityRelationsFixtureUrl);
  const decoded = Schema.decodeUnknownSync(EntityRelationsSchema)(fixture);
  const encoded = Schema.encodeSync(EntityRelationsSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("Decision event schema rejects unknown fields and canonical-invalid values", async () => {
  const unknownField = await readJson(invalidDecisionFixtureUrl);
  const base = (await readJson(validDecisionFixtureUrl)) as Record<string, any>;

  assert.throws(() => Schema.decodeUnknownSync(DecisionEventSchema)(unknownField));
  assert.throws(() =>
    Schema.decodeUnknownSync(DecisionEventSchema)({ ...base, payload: { ...base.payload, question: "q".repeat(500) } }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(DecisionEventSchema)({ ...base, payload: { ...base.payload, rejected: [] } }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(DecisionEventSchema)({
      ...base,
      payload: { ...base.payload, rejected: [{ id: "CH1", text: "Duplicate id", whyNot: "Ambiguous anchor" }] },
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(DecisionEventSchema)({ ...base, actor: { principal: { personId: "" }, executor: null } }),
  );
});

test("entity relations schema rejects contract-critical invalid fixtures", async () => {
  const invalidEndpoint = await readJson(invalidEntityRelationsFixtureUrl);
  const base = (await readJson(validEntityRelationsFixtureUrl)) as Record<string, any>;
  const [relation] = base.relations as Array<Record<string, unknown>>;

  assert.throws(() => Schema.decodeUnknownSync(EntityRelationsSchema)(invalidEndpoint));
  assert.throws(() =>
    Schema.decodeUnknownSync(EntityRelationsSchema)({
      ...base,
      host: "decision/dec_OTHER",
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EntityRelationsSchema)({
      ...base,
      relations: [
        relation,
        { ...relation, strength: "weak", rationale: "Same canonical edge with different mutable attributes." },
      ],
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EntityRelationsSchema)({
      ...base,
      relations: [{ ...relation, rationale: "   " }],
    }),
  );
  const { rationale: _rationale, ...strongRelationWithoutRationale } = relation;
  assert.throws(() =>
    Schema.decodeUnknownSync(EntityRelationsSchema)({
      ...base,
      relations: [strongRelationWithoutRationale],
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EntityRelationsSchema)({
      ...base,
      relations: [{ ...relation, relation_id: "rel_0000000000000000" }],
    }),
  );
});

test("Decision event JSON schema publishes a closed canonical envelope", async () => {
  const jsonSchema = (await readJson(decisionJsonSchemaUrl)) as {
    readonly additionalProperties?: boolean;
    readonly required?: readonly string[];
    readonly properties?: Record<string, { readonly const?: string; readonly enum?: readonly string[] }>;
  };

  assert.equal(jsonSchema.additionalProperties, false);
  assert.equal(jsonSchema.properties?.schema?.const, "decision-event/v1");
  assert.equal(jsonSchema.required?.includes("payload"), true);
  assert.equal(jsonSchema.properties?.type?.enum?.includes("decision_retired"), true);
});

test("entity relations JSON schema is closed and uses canonical fact refs", async () => {
  const jsonSchema = (await readJson(entityRelationsJsonSchemaUrl)) as {
    readonly additionalProperties?: boolean;
    readonly properties?: Record<string, unknown>;
    readonly $defs?: Record<
      string,
      {
        readonly additionalProperties?: boolean;
        readonly pattern?: string;
        readonly properties?: Record<string, unknown>;
      }
    >;
  };

  assert.equal(jsonSchema.additionalProperties, false);
  assert.equal(jsonSchema.$defs?.relationRecord.additionalProperties, false);
  assert.match(jsonSchema.$defs?.entityRef.pattern ?? "", /fact\//u);
  assert.doesNotMatch(jsonSchema.$defs?.entityRef.pattern ?? "", /fact\/\[A-Za-z0-9_-\]\+\?/u);
});

test("Fact event JSON schema publishes a closed classified payload", async () => {
  const jsonSchema = (await readJson(factEventJsonSchemaUrl)) as {
    readonly additionalProperties?: boolean;
    readonly properties?: Record<
      string,
      {
        readonly additionalProperties?: boolean;
        readonly required?: ReadonlyArray<string>;
        readonly properties?: Record<
          string,
          {
            readonly enum?: ReadonlyArray<string>;
            readonly type?: string;
            readonly items?: { readonly enum?: ReadonlyArray<string> };
          }
        >;
      }
    >;
  };

  assert.equal(jsonSchema.additionalProperties, false);
  assert.equal(jsonSchema.properties?.payload?.additionalProperties, false);
  assert.equal(jsonSchema.properties?.payload?.required?.includes("memoryClass"), true);
  assert.equal(jsonSchema.properties?.payload?.required?.includes("memoryTags"), true);
  assert.deepEqual(jsonSchema.properties?.payload?.properties?.memoryClass?.enum, [
    "semantic",
    "episodic",
    "procedural",
  ]);
  assert.equal(jsonSchema.properties?.payload?.properties?.memoryTags?.type, "array");
  assert.deepEqual(jsonSchema.properties?.payload?.properties?.memoryTags?.items?.enum, [
    "episode",
    "procedural",
    "tool_memory",
    "pattern",
    "task_skill",
    "abstract_rule",
    "other",
  ]);
});

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}
