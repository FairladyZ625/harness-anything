#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { architectureManifestJsonSchema } from "../packages/cli/src/commands/extensions/assets/software-coding/architecture/contracts/architecture-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativeSchemaPath = "packages/cli/src/commands/extensions/assets/software-coding/architecture/contracts/architecture-manifest.schema.json";
const schemaPath = path.join(root, relativeSchemaPath);
const expected = `${JSON.stringify(architectureManifestJsonSchema(), null, 2)}\n`;
const checkOnly = process.argv.includes("--check");
const actual = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : undefined;

if (actual === expected) {
  console.log(`Generated architecture manifest schema is fresh: ${relativeSchemaPath}`);
} else if (checkOnly) {
  console.error(`Generated architecture manifest schema is stale: ${relativeSchemaPath}`);
  process.exitCode = 1;
} else {
  writeFileSync(schemaPath, expected, "utf8");
  console.log(`Generated architecture manifest schema updated: ${relativeSchemaPath}`);
}
