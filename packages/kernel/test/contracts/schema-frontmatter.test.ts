import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Schema } from "effect";
import { DecisionPackageSchema, TaskFrontmatterSchema } from "../../src/schemas/registry.ts";

const validFixtureUrl = new URL("../../fixtures/schemas/task-frontmatter/valid.json", import.meta.url);
const validDecisionFixtureUrl = new URL("../../fixtures/schemas/decision-package/valid.json", import.meta.url);
const invalidDecisionFixtureUrl = new URL("../../fixtures/schemas/decision-package/invalid.json", import.meta.url);
const decisionJsonSchemaUrl = new URL("../../schemas/json/decision-package.schema.json", import.meta.url);

test("task frontmatter schema decodes and encodes the valid fixture", async () => {
  const fixture = JSON.parse(await readFile(validFixtureUrl, "utf8")) as unknown;
  const decoded = Schema.decodeUnknownSync(TaskFrontmatterSchema)(fixture);
  const encoded = Schema.encodeSync(TaskFrontmatterSchema)(decoded);

  assert.deepEqual(encoded, fixture);
});

test("decision package schema decodes and encodes the valid fixture", async () => {
  const fixture = await readJson(validDecisionFixtureUrl);
  const decoded = Schema.decodeUnknownSync(DecisionPackageSchema)(fixture);
  const encoded = Schema.encodeSync(DecisionPackageSchema)(decoded);

  assert.deepEqual(encoded, fixture);
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
});

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}
