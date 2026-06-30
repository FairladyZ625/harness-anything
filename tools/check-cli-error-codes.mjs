import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryPath = "packages/cli/src/cli/error-codes.ts";
const sourceRoot = "packages/cli/src";
const scannedExtensions = new Set([".ts"]);
const excludedFiles = new Set([
  registryPath,
  "packages/cli/src/cli/types.ts"
]);

export function findCliErrorCodeViolations(rootDir = process.cwd()) {
  const violations = [];
  const registrySource = readFileSync(path.join(rootDir, registryPath), "utf8");
  const codeEntries = cliErrorCodeEntries(registrySource);
  const codeNames = new Set(codeEntries.map((entry) => entry.name));
  const codeValues = new Map();
  const duplicateValues = new Set();

  for (const entry of codeEntries) {
    if (codeValues.has(entry.value)) duplicateValues.add(entry.value);
    codeValues.set(entry.value, entry.name);
  }
  for (const value of duplicateValues) {
    violations.push(`CliErrorCode value ${value} is duplicated`);
  }

  const registryNames = cliErrorRegistryNames(registrySource);
  for (const name of codeNames) {
    if (!registryNames.has(name)) violations.push(`CliErrorCode.${name} is missing cliErrorCodeRegistry metadata`);
  }
  for (const name of registryNames) {
    if (!codeNames.has(name)) violations.push(`cliErrorCodeRegistry has stale CliErrorCode.${name}`);
  }
  for (const exportedName of ["CliErrorCode", "cliErrorCodeRegistry", "cliError", "isCliErrorCode"]) {
    if (!registrySource.includes(`export ${exportedName}`) && !registrySource.includes(`export function ${exportedName}`) && !registrySource.includes(`export const ${exportedName}`)) {
      violations.push(`${registryPath} must export ${exportedName}`);
    }
  }

  for (const file of walkFiles(path.join(rootDir, sourceRoot))) {
    const relative = path.relative(rootDir, file);
    if (excludedFiles.has(relative) || !scannedExtensions.has(path.extname(file))) continue;
    const source = readFileSync(file, "utf8");
    violations.push(...inlineCliResultErrorViolations(relative, source));
  }

  return violations;
}

function cliErrorCodeEntries(source) {
  const objectSource = extractAssignedLiteral(source, "CliErrorCode");
  return [...objectSource.matchAll(/^\s*([A-Za-z0-9]+):\s*"([A-Za-z0-9_:-]+)"/gmu)]
    .map((match) => ({ name: match[1], value: match[2] }));
}

function cliErrorRegistryNames(source) {
  const registrySource = extractAssignedLiteral(source, "cliErrorCodeRegistry");
  return new Set([...registrySource.matchAll(/\[\s*CliErrorCode\.([A-Za-z0-9]+)\s*\]\s*:/gmu)].map((match) => match[1]));
}

function inlineCliResultErrorViolations(relativePath, source) {
  const violations = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\bcode\s*:/u.test(line)) continue;
    if (/\bfunction\b/u.test(line)) continue;
    const windowText = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 5)).join("\n");
    if (!/\bhint\s*:/u.test(windowText)) continue;
    if (/\breadonly\s+code\s*:/u.test(line)) continue;
    const match = line.match(/\bcode\s*:\s*(["'`][^"'`]*["'`]|CliErrorCode\.[A-Za-z0-9]+|[A-Za-z0-9_$]+\()/u);
    const value = match?.[1] ?? "dynamic code";
    violations.push(`${relativePath}:${index + 1} uses inline CliResult error code ${value}; use cliError(CliErrorCode.*)`);
  }
  return violations;
}

function extractAssignedLiteral(source, constName) {
  const declaration = new RegExp(`\\b(?:export\\s+)?const\\s+${constName}\\b[^=]*=`, "u").exec(source);
  if (!declaration) throw new Error(`missing ${constName}`);
  const start = declaration.index + declaration[0].length;
  const objectStart = source.indexOf("{", start);
  if (objectStart < 0) throw new Error(`missing ${constName} object literal`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(objectStart, index + 1);
  }
  throw new Error(`unterminated ${constName}`);
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stats = statSync(file);
    if (stats.isDirectory()) {
      files.push(...walkFiles(file));
    } else {
      files.push(file);
    }
  }
  return files;
}

function main() {
  const violations = findCliErrorCodeViolations();
  if (violations.length === 0) return;

  console.error("CLI error code gate failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
