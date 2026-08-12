#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  makeMarkdownArtifactStore,
  normalizeRelativeDocumentPath,
  readDocmapManifest,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout
} from "../packages/kernel/src/index.ts";

const freshnessWindowMs = 7 * 24 * 60 * 60 * 1000;
const retiredCliGenerator = "packages/cli/src/commands/core/docmap-generate.ts";

export function checkDocmapFresh(rootDir = process.cwd()) {
  if (existsSync(path.join(rootDir, retiredCliGenerator))) {
    return { ok: false, skipped: false, message: `${retiredCliGenerator} is a W3-retired CLI write path and must not return.` };
  }
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
    message: "Docmap freshness check failed: harness/docmap.json is stale. Update the private manifest through its owning harness authority.",
    diff: summarizeDiff(persisted.documents, derived.documents)
  };
}

function deriveDocmapManifest(rootDir) {
  const layout = resolveHarnessLayout(rootDir);
  const documents = [];
  for (const candidate of [path.join(layout.authoredRoot, "AGENTS.md"), path.join(layout.authoredRoot, "governance", "standards"),
    layout.adrRoot, layout.milestonesRoot]) collectMarkdownDocuments(layout.authoredRoot, candidate, documents);
  const unique = new Map(documents.map((document) => [document.path, document]));
  return { manifest: { schema: "docmap/v1", documents: [...unique.values()].sort(compareDocuments) } };
}

function collectMarkdownDocuments(authoredRoot, absolutePath, documents) {
  if (!existsSync(absolutePath)) return;
  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolutePath).filter((name) => !name.startsWith("."))) {
      collectMarkdownDocuments(authoredRoot, path.join(absolutePath, entry), documents);
    }
    return;
  }
  if (!absolutePath.endsWith(".md")) return;
  const relativePath = normalizeRelativeDocumentPath(path.relative(authoredRoot, absolutePath).split(path.sep).join("/"));
  const body = readFileSync(absolutePath, "utf8"), frontmatter = readFrontmatter(body), inferred = inferDocument(relativePath);
  const modules = frontmatter ? readList(frontmatter, "modules", "docmap.modules") : [];
  const productLines = frontmatter ? readList(frontmatter, "productLines", "docmap.productLines") : [];
  const unused = frontmatter ? readBoolean(frontmatter, "unused", "docmap.unused") : false;
  documents.push({ id: firstNonEmpty(frontmatter ? readScalar(frontmatter, "docmap.id") : "", frontmatter ? readScalar(frontmatter, "id") : "", inferred.id),
    path: relativePath, kind: inferred.kind, scope: { modules: modules.length > 0 ? modules : inferred.modules,
      productLines: productLines.length > 0 ? productLines : inferred.productLines }, updatedAt: stat.mtime.toISOString(), ...(unused ? { unused } : {}) });
}

function inferDocument(relativePath) {
  const parts = relativePath.split("/");
  if (relativePath === "AGENTS.md") return { id: "operating:AGENTS", kind: "standard", modules: [], productLines: [] };
  if (parts[0] === "governance" && parts[1] === "standards") return { id: `standard:${basenameId(relativePath)}`, kind: "standard", modules: [], productLines: [] };
  if (parts[0] === "adr") return { id: `adr:${basenameId(relativePath)}`, kind: "adr", modules: [], productLines: [] };
  if (parts[0] === "milestones") { const productLine = parts.length > 2 ? parts[1] ?? "" : "root", moduleKey = parts.length > 3 ? parts[2] ?? "" : "";
    return { id: `milestone:${[productLine, moduleKey, basenameId(relativePath)].filter(Boolean).join(":")}`, kind: "roadmap",
      modules: moduleKey ? [moduleKey] : [], productLines: productLine === "root" ? [] : [productLine] }; }
  const moduleKey = parts.find((part) => /^m\d[-\w]*$/iu.test(part));
  return { id: `architecture:${basenameId(relativePath)}`, kind: "architecture", modules: moduleKey ? [moduleKey] : [], productLines: [] };
}

function readList(frontmatter, ...keys) {
  for (const key of keys) { const scalar = readScalar(frontmatter, key); if (scalar) return scalar.split(",").map((item) => item.trim()).filter(Boolean);
    const block = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\n((?:[ \\t]+- .*\\n?)*)`, "mu"))?.[1];
    if (block) return block.split(/\r?\n/u).map((line) => line.match(/^\s*-\s*(.*)$/u)?.[1]?.trim() ?? "").filter(Boolean); }
  return [];
}
function readBoolean(frontmatter, ...keys) { return keys.some((key) => readScalar(frontmatter, key).trim().toLowerCase() === "true"); }
function basenameId(relativePath) { return path.basename(relativePath, ".md").replace(/[^A-Za-z0-9_.:/@-]+/gu, "-"); }
function firstNonEmpty(...values) { return values.find((value) => value.trim().length > 0)?.trim() ?? ""; }
function compareDocuments(left, right) { return left.path.localeCompare(right.path, "en-US") || left.id.localeCompare(right.id, "en-US"); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

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
