#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { readDocmapManifest } from "../packages/kernel/src/docmap/index.ts";
import { deriveDocmapManifest } from "../packages/cli/src/commands/core/docmap-generate.ts";

export function checkDocmapFresh(rootDir = process.cwd()) {
  const authoredRoot = path.join(rootDir, "harness");
  const manifestPath = path.join(authoredRoot, "docmap.json");
  if (!existsSync(authoredRoot) || !existsSync(manifestPath)) {
    return {
      ok: true,
      skipped: true,
      message: "Docmap freshness check skipped: private harness/docmap.json is not present in this checkout."
    };
  }

  const persisted = readDocmapManifest(rootDir).manifest;
  const derived = deriveDocmapManifest(rootDir).manifest;
  const persistedText = stableJson(persisted);
  const derivedText = stableJson(derived);
  if (persistedText === derivedText) {
    return {
      ok: true,
      skipped: false,
      message: `Docmap freshness check passed: ${persisted.documents.length} document(s).`
    };
  }
  return {
    ok: false,
    skipped: false,
    message: "Docmap freshness check failed: harness/docmap.json is stale. Run `ha doc generate --write --json` and commit the updated private manifest.",
    diff: summarizeDiff(persisted.documents, derived.documents)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkDocmapFresh(process.cwd());
  if (!result.ok) {
    console.error(result.message);
    for (const line of result.diff ?? []) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log(result.message);
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortValue(nested)]));
}

function summarizeDiff(persisted, derived) {
  const persistedById = new Map(persisted.map((document) => [document.id, document]));
  const derivedById = new Map(derived.map((document) => [document.id, document]));
  const lines = [];
  for (const id of [...derivedById.keys()].sort()) {
    if (!persistedById.has(id)) lines.push(`missing persisted id: ${id}`);
  }
  for (const id of [...persistedById.keys()].sort()) {
    if (!derivedById.has(id)) lines.push(`obsolete persisted id: ${id}`);
  }
  return lines.slice(0, 20);
}
