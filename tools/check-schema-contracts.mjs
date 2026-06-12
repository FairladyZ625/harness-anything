import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Schema } from "effect";
import { schemaRegistry } from "../packages/kernel/src/schemas/registry.ts";

const root = process.cwd();
const expectedSchemaIds = [
  "harness-config",
  "task-frontmatter",
  "write-journal-op",
  "task-snapshot",
  "publishable-projection",
  "template-catalog",
  "preset-manifest",
  "vertical-definition",
  "sqlite-task-row",
  "harness-check-report",
  "docs-release-promotion-bundle"
];
const violations = [];

function record(message) {
  violations.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

const registryIds = schemaRegistry.map((entry) => entry.id).sort();
const expectedIds = [...expectedSchemaIds].sort();
if (JSON.stringify(registryIds) !== JSON.stringify(expectedIds)) {
  record(`schema registry ids must be exactly: ${expectedIds.join(", ")}`);
}

for (const entry of schemaRegistry) {
  for (const filePath of [entry.jsonSchemaPath, entry.validFixturePath, entry.invalidFixturePath]) {
    if (!existsSync(path.join(root, filePath))) record(`${entry.id}: missing ${filePath}`);
  }

  if (!existsSync(path.join(root, entry.jsonSchemaPath))) continue;
  const jsonSchema = readJson(entry.jsonSchemaPath);
  if (jsonSchema["x-harness-schema-id"] !== entry.id) {
    record(`${entry.jsonSchemaPath}: x-harness-schema-id must be ${entry.id}`);
  }
  if (jsonSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    record(`${entry.jsonSchemaPath}: $schema must be draft 2020-12`);
  }
  if (jsonSchema.type !== "object") {
    record(`${entry.jsonSchemaPath}: top-level type must be object`);
  }
  if (!Array.isArray(jsonSchema.required) || jsonSchema.required.length === 0) {
    record(`${entry.jsonSchemaPath}: required must name the contract-critical fields`);
  }

  if (existsSync(path.join(root, entry.validFixturePath))) {
    const fixture = readJson(entry.validFixturePath);
    try {
      Schema.decodeUnknownSync(entry.schema)(fixture);
    } catch (error) {
      record(`${entry.validFixturePath}: valid fixture failed decode: ${error.message}`);
    }
  }

  if (existsSync(path.join(root, entry.invalidFixturePath))) {
    const fixture = readJson(entry.invalidFixturePath);
    try {
      Schema.decodeUnknownSync(entry.schema)(fixture);
      record(`${entry.invalidFixturePath}: invalid fixture unexpectedly decoded`);
    } catch {
      // Expected: invalid fixture must fail the Effect Schema decoder.
    }
  }
}

const fixtureRoot = path.join(root, "packages/kernel/fixtures/schemas");
if (existsSync(fixtureRoot)) {
  const fixtureDirs = (await readdir(fixtureRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(fixtureDirs) !== JSON.stringify(expectedIds)) {
    record(`schema fixture directories must match registry ids: ${expectedIds.join(", ")}`);
  }
}

if (violations.length > 0) {
  console.error("Schema contract check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
