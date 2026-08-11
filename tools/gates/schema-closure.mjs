import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDerivedContracts, loadContracts, discoverContractFiles } from "./derived-contracts.mjs";
import { repoRoot } from "./git.mjs";

const SOURCE_FILE = /\.(?:c|m)?js$|\.(?:d\.)?tsx?$/u;
const IGNORED_DIRECTORIES = new Set([".git", "coverage", "dist", "fixtures", "node_modules", "test", "tests"]);
const LEGACY_READER_MARKER = ["@legacy", "reader"].join("-");

function splitReference(reference) {
  if (typeof reference !== "string") return null;
  const separator = reference.lastIndexOf("#");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return { file: reference.slice(0, separator), name: reference.slice(separator + 1) };
}

async function loadExport(rootDir, reference, facet, schemaId, errors) {
  const parsed = splitReference(reference);
  if (parsed === null) {
    errors.push(`${schemaId}: ${facet} must use path#export notation`);
    return undefined;
  }
  const absolutePath = path.join(rootDir, parsed.file);
  if (!existsSync(absolutePath)) {
    errors.push(`${schemaId}: ${facet} module not found: ${parsed.file}`);
    return undefined;
  }
  const module = await import(`${pathToFileURL(absolutePath).href}?facet=${encodeURIComponent(facet)}`);
  if (!Object.hasOwn(module, parsed.name)) {
    errors.push(`${schemaId}: ${facet} export not found: ${reference}`);
    return undefined;
  }
  return module[parsed.name];
}

function legacyReaders(directory, rootDir, found) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) legacyReaders(fullPath, rootDir, found);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name) && readFileSync(fullPath, "utf8").includes(LEGACY_READER_MARKER)) {
      found.push(path.relative(rootDir, fullPath).split(path.sep).join("/"));
    }
  }
}

export function findLegacyReaders(rootDir) {
  const found = [];
  for (const directory of ["packages", "src", "tools/gates"]) legacyReaders(path.join(rootDir, directory), rootDir, found);
  return found.sort();
}

export async function validateSchemaClosure(rootDir, contracts) {
  const errors = [];
  for (const file of findLegacyReaders(rootDir)) errors.push(`${file}: ${LEGACY_READER_MARKER} is forbidden on the rebuild line`);
  for (const contract of contracts) {
    for (const schema of contract.declaration.schemas ?? []) {
      const schemaId = `${contract.file}:${schema.id ?? "<unnamed>"}`;
      if (typeof schema.id !== "string" || schema.id.length === 0) errors.push(`${schemaId}: schema id is required`);
      const schemaValue = await loadExport(rootDir, schema.schema, "schema", schemaId, errors);
      const parser = await loadExport(rootDir, schema.parser, "parser", schemaId, errors);
      const writer = await loadExport(rootDir, schema.writer, "writer", schemaId, errors);
      const errorType = await loadExport(rootDir, schema.error, "error", schemaId, errors);
      if (schemaValue !== undefined && (schemaValue === null || typeof schemaValue !== "object")) errors.push(`${schemaId}: schema export must be an object`);
      if (parser !== undefined && typeof parser !== "function") errors.push(`${schemaId}: parser export must be a function`);
      if (writer !== undefined && typeof writer !== "function") errors.push(`${schemaId}: writer export must be a function`);
      if (errorType !== undefined && typeof errorType !== "function") errors.push(`${schemaId}: error export must be a constructor`);
      if (!Array.isArray(schema.negativeFixtures) || schema.negativeFixtures.length === 0) {
        errors.push(`${schemaId}: at least one negative fixture is required`);
      } else {
        for (const fixture of schema.negativeFixtures) {
          const fixturePath = path.join(rootDir, fixture);
          if (!existsSync(fixturePath)) {
            errors.push(`${schemaId}: negative fixture not found: ${fixture}`);
          } else if (typeof parser === "function") {
            const parsed = JSON.parse(readFileSync(fixturePath, "utf8"));
            const result = parser(parsed);
            if (!Array.isArray(result) || result.length === 0) errors.push(`${schemaId}: negative fixture was accepted: ${fixture}`);
          }
        }
      }
    }
  }
  return errors;
}

export async function checkSchemaClosure(rootDir) {
  const derivedErrors = await checkDerivedContracts(rootDir);
  if (derivedErrors.length > 0) return derivedErrors;
  return validateSchemaClosure(rootDir, await loadContracts(rootDir, discoverContractFiles(rootDir)));
}

async function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/schema-closure.mjs --check");
  const errors = await checkSchemaClosure(repoRoot());
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("schema-closure: ok");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
