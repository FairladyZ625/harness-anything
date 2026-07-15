#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSONSchema } from "effect";
import { PresetManifestSchema } from "../packages/kernel/src/schemas/registry.ts";

const root = process.cwd();
const target = "packages/kernel/schemas/json/preset-manifest.schema.json";
const expected = `${JSON.stringify(generatedPresetManifestSchema(), null, 2)}\n`;
const absolute = path.join(root, target);
const actual = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;

if (process.argv.includes("--check")) {
  if (actual !== expected) {
    console.error(`Generated preset manifest contract is stale: ${target}`);
    process.exit(1);
  }
  console.log("Generated preset manifest contract is fresh (registry-derived v1/v2/v3 union).");
} else {
  writeFileSync(absolute, expected, "utf8");
  console.log(`Generated preset manifest contract updated: ${target}`);
}

function generatedPresetManifestSchema() {
  const schema = JSONSchema.make(PresetManifestSchema);
  return {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://harness-anything.dev/schemas/preset-manifest.schema.json",
    "x-harness-schema-id": "preset-manifest",
    title: "Preset Manifest",
    type: "object",
    required: [
      "schema",
      "id",
      "title",
      "vertical",
      "version",
      "kernelVersionRange",
      "capabilityImports",
      "profiles",
      "defaultProfile"
    ]
  };
}
