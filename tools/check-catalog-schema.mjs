#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const catalogPath = "packages/cli/src/commands/extensions/assets/software-coding/template-catalog.json";
const absoluteCatalogPath = path.join(root, catalogPath);
const catalogRoot = path.dirname(absoluteCatalogPath);
const failures = [];

function fail(message) {
  failures.push(message);
}

const catalog = JSON.parse(readFileSync(absoluteCatalogPath, "utf8"));

if (catalog.schema !== "template-catalog/v2") {
  fail(`${catalogPath}: schema must be template-catalog/v2`);
}

if (!Array.isArray(catalog.documents)) {
  fail(`${catalogPath}: documents must be an array`);
} else {
  for (const [documentIndex, document] of catalog.documents.entries()) {
    if (!document || typeof document !== "object" || !Array.isArray(document.locales)) {
      fail(`${catalogPath}: documents[${documentIndex}].locales must be an array`);
      continue;
    }
    for (const [localeIndex, locale] of document.locales.entries()) {
      const prefix = `${catalogPath}: documents[${documentIndex}].locales[${localeIndex}]`;
      if (!locale || typeof locale !== "object") {
        fail(`${prefix} must be an object`);
        continue;
      }
      if (Object.hasOwn(locale, "body")) {
        fail(`${prefix}.body must not be inline; use bodyPath`);
      }
      if (typeof locale.bodyPath !== "string") {
        fail(`${prefix}.bodyPath must be a string`);
        continue;
      }
      if (!isSafeBodyPath(locale.bodyPath)) {
        fail(`${prefix}.bodyPath must be a safe relative .md path`);
        continue;
      }
      const resolved = path.resolve(catalogRoot, locale.bodyPath);
      if (!resolved.startsWith(`${catalogRoot}${path.sep}`)) {
        fail(`${prefix}.bodyPath must stay inside ${path.relative(root, catalogRoot)}`);
        continue;
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        fail(`${prefix}.bodyPath target is missing: ${locale.bodyPath}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Template catalog schema check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Template catalog schema check passed.");

function isSafeBodyPath(value) {
  if (path.isAbsolute(value) || value.includes("\\") || !value.endsWith(".md")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
