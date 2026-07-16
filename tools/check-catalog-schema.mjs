#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const catalogPath = "packages/cli/src/commands/extensions/assets/software-coding/template-catalog.json";
const absoluteCatalogPath = path.join(root, catalogPath);
const catalogRoot = path.dirname(absoluteCatalogPath);
const lockPath = path.join(catalogRoot, "extension-contract.lock.json");
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

validateContractLock();

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

function validateContractLock() {
  if (!existsSync(lockPath)) {
    fail(`${path.relative(root, lockPath)}: extension contract lock is missing`);
    return;
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    fail(`${path.relative(root, lockPath)}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (lock.schema !== "extension-contract-lock/v1" || !lock.catalog || !Array.isArray(lock.presets)) {
    fail(`${path.relative(root, lockPath)}: expected extension-contract-lock/v1 with catalog and presets`);
    return;
  }

  const bodies = {};
  for (const document of catalog.documents ?? []) {
    for (const locale of document.locales ?? []) {
      if (typeof locale.bodyPath === "string" && isSafeBodyPath(locale.bodyPath)) {
        const bodyPath = path.join(catalogRoot, locale.bodyPath);
        if (existsSync(bodyPath)) bodies[locale.bodyPath] = normalizeTextForDigest(readFileSync(bodyPath, "utf8"));
      }
    }
  }
  const expectedCatalog = {
    id: catalog.package?.id,
    version: catalog.package?.version,
    digest: digest({ catalog, bodies })
  };
  if (JSON.stringify(lock.catalog) !== JSON.stringify(expectedCatalog)) {
    fail(`${path.relative(root, lockPath)}: catalog lock mismatch; bump catalog version and refresh its digest intentionally`);
  }

  const indexPath = path.join(catalogRoot, "presets", "index.json");
  const presetIds = JSON.parse(readFileSync(indexPath, "utf8")).presets ?? [];
  const expectedPresets = presetIds.map((presetId) => {
    const manifest = JSON.parse(readFileSync(path.join(catalogRoot, "presets", presetId, "preset.json"), "utf8"));
    return { id: presetId, version: manifest.version, digest: digest(manifest) };
  });
  if (JSON.stringify(lock.presets) !== JSON.stringify(expectedPresets)) {
    fail(`${path.relative(root, lockPath)}: preset lock mismatch; keep index order, bump changed preset versions, and refresh digests intentionally`);
  }
}

function normalizeTextForDigest(value) {
  return value.replace(/\r\n?/gu, "\n");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
