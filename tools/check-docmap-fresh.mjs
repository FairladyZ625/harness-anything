#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { makeMarkdownArtifactStore, readDocmapManifest } from "../packages/kernel/src/index.ts";
import { deriveDocmapManifest } from "../packages/cli/src/commands/core/docmap-generate.ts";

const freshnessWindowMs = 7 * 24 * 60 * 60 * 1000;

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

  const persisted = readDocmapManifest(rootDir, makeMarkdownArtifactStore({ rootDir })).manifest;
  const derived = deriveDocmapManifest(rootDir).manifest;
  const persistedText = stableJson(routingManifest(persisted));
  const derivedText = stableJson(routingManifest(derived));
  const warnings = freshnessWarnings(authoredRoot, persisted.documents);
  if (persistedText === derivedText) {
    return {
      ok: true,
      skipped: false,
      message: warnings.length > 0
        ? `Docmap freshness check passed with ${warnings.length} warning(s): ${persisted.documents.length} document(s).`
        : `Docmap freshness check passed: ${persisted.documents.length} document(s).`,
      warnings
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
  for (const line of result.warnings ?? []) console.warn(`warning: ${line}`);
  if (!result.ok) {
    console.error(result.message);
    for (const line of result.diff ?? []) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log(result.message);
}

function routingManifest(manifest) {
  return {
    schema: manifest.schema,
    documents: manifest.documents.map((document) => {
      const { updatedAt: _updatedAt, unused: _unused, ...routing } = document;
      return routing;
    })
  };
}

function freshnessWarnings(authoredRoot, documents) {
  const warnings = [];
  for (const document of documents) {
    const documentPath = path.join(authoredRoot, document.path);
    if (!existsSync(documentPath)) continue;
    const updatedAtMs = Date.parse(document.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      warnings.push(`${document.id}: invalid updatedAt '${document.updatedAt}'`);
      continue;
    }
    const sourceMtimeMs = statSync(documentPath).mtime.getTime();
    const staleByMs = sourceMtimeMs - updatedAtMs;
    if (staleByMs > freshnessWindowMs) {
      warnings.push(`${document.id}: updatedAt lags source document mtime by ${Math.floor(staleByMs / freshnessWindowMs)} freshness window(s)`);
    }
  }
  return warnings;
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
