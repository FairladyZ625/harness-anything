// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSONSchema, Schema } from "effect";
import { PresetManifestSchema } from "../../src/index.ts";
import { presetCapabilityCatalog } from "../../src/schemas/preset-manifest-v3.ts";

const validFixture = JSON.parse(readFileSync(
  "packages/kernel/fixtures/schemas/preset-manifest/valid-v3.json",
  "utf8"
)) as Record<string, unknown>;

test("preset manifest v3 decodes the semantic capability fixture", () => {
  const decoded = Schema.decodeUnknownSync(PresetManifestSchema)(validFixture);
  assert.equal(decoded.schema, "preset-manifest/v3");
  assert.equal(decoded.entrypoints?.audit?.requires.length, 12);
  assert.equal(decoded.entrypoints?.audit?.produces.length, 2);
});

test("preset manifest v3 rejects legacy physical scopes and missing semantic fields", () => {
  const entrypoint = structuredClone((validFixture.entrypoints as Record<string, Record<string, unknown>>).audit);
  delete entrypoint.intent;
  entrypoint.reads = ["{{paths.tasksRoot}}/**"];
  entrypoint.writes = ["{{outputRoot}}/**"];
  const candidate = { ...validFixture, entrypoints: { audit: entrypoint } };

  assert.throws(() => Schema.decodeUnknownSync(PresetManifestSchema)(candidate));
});

test("preset manifest v3 rejects unknown capability versions and selector shapes", () => {
  const invalidVersion = JSON.parse(readFileSync(
    "packages/kernel/fixtures/schemas/preset-manifest/invalid-v3.json",
    "utf8"
  )) as unknown;
  assert.throws(() => Schema.decodeUnknownSync(PresetManifestSchema)(invalidVersion));

  const candidate = structuredClone(validFixture);
  const audit = (candidate.entrypoints as Record<string, Record<string, unknown>>).audit;
  audit.requires = [{ capability: "tasks", version: "1", select: { scope: "all", view: "full-filesystem" } }];
  assert.throws(() => Schema.decodeUnknownSync(PresetManifestSchema)(candidate));
});

test("capability catalog freezes each v1 data shape and authority envelope", () => {
  assert.deepEqual(presetCapabilityCatalog.map(({ id }) => id), [
    "tasks",
    "decisions",
    "adrs",
    "operating-docs",
    "task-artifacts",
    "relation-graph",
    "runtime-events",
    "generated-artifacts",
    "write-journal",
    "docmap",
    "task-documents",
    "external-source-pack",
    "repository-source"
  ]);
  assert.equal(presetCapabilityCatalog.every((entry) => (
    entry.version === "1" && entry.dataShape.length > 0 && entry.authorityEnvelope.length > 0
  )), true);
});

test("published preset JSON schema is derived from the registry v1/v2/v3 union", () => {
  const published = JSON.parse(readFileSync(
    "packages/kernel/schemas/json/preset-manifest.schema.json",
    "utf8"
  )) as {
    readonly anyOf: ReadonlyArray<unknown>;
    readonly [key: string]: unknown;
  };
  const derived = JSONSchema.make(PresetManifestSchema) as { readonly anyOf: ReadonlyArray<unknown> };
  assert.deepEqual(published.anyOf, derived.anyOf);
  assert.equal(JSON.stringify(published).includes("preset-manifest/v3"), true);
  assert.equal(JSON.stringify(published).includes("raw-fs"), true);
});
