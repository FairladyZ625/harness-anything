import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import type { DocmapDocument, DocmapManifest, DocmapReadSet } from "../../../../kernel/src/index.ts";
import { buildDocmapReadSet, docmapManifestPath, moduleEntityId, type WriteCoordinator, type WriteError } from "../../../../kernel/src/index.ts";
import { assertUniqueDocmapIds } from "../../../../kernel/src/index.ts";
import { readFrontmatter, readScalar } from "../../../../kernel/src/index.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { DocmapManifestSchema } from "../../../../kernel/src/index.ts";
import { writeCoordinatedPayload } from "./coordinated-machine-write.ts";

export interface DerivedDocmapResult {
  readonly manifest: DocmapManifest;
  readonly path: string;
  readonly relativePath: string;
}

export function deriveDocmapManifest(rootInput: HarnessLayoutInput): DerivedDocmapResult {
  const layout = resolveHarnessLayout(rootInput);
  const docs = discoverDocmapDocuments(rootInput);
  assertUniqueDocmapIds(docs);
  const manifest = Schema.decodeUnknownSync(DocmapManifestSchema)({
    schema: "docmap/v1",
    documents: docs
  }) as DocmapManifest;
  const manifestPath = docmapManifestPath(rootInput);
  return {
    manifest: {
      schema: "docmap/v1",
      documents: [...manifest.documents].sort(compareDocuments)
    },
    path: manifestPath,
    relativePath: path.relative(layout.rootDir, manifestPath).split(path.sep).join("/")
  };
}

export function writeDerivedDocmapManifest(rootInput: HarnessLayoutInput, coordinator: WriteCoordinator): Effect.Effect<DerivedDocmapResult, WriteError> {
  const derived = deriveDocmapManifest(rootInput);
  return writeCoordinatedPayload(coordinator, {
    entityId: moduleEntityId("docmap"),
    kind: "machine_artifact_write",
    opIdPrefix: "docmap-derived",
    payload: {
      boundary: "docmap-derived",
      path: derived.relativePath,
      body: `${JSON.stringify(derived.manifest, null, 2)}\n`
    }
  }).pipe(Effect.map(() => derived));
}

export function buildDerivedDocmapReadSet(rootInput: HarnessLayoutInput, moduleKey?: string, productLine?: string): {
  readonly source: "derived";
  readonly manifest: DocmapManifest;
  readonly readSet: DocmapReadSet;
} {
  const manifest = deriveDocmapManifest(rootInput).manifest;
  return {
    source: "derived",
    manifest,
    readSet: buildDocmapReadSet(manifest, { moduleKey, productLine })
  };
}

export function renderDocmapReadSetMarkdown(readSet: DocmapReadSet, options: {
  readonly title: string;
  readonly moduleKey?: string;
  readonly source: "persisted" | "derived";
}): string {
  return [
    "# Required Reading",
    "",
    `Task: ${options.title}`,
    ...(options.moduleKey ? [`Module: ${options.moduleKey}`] : []),
    `Docmap source: ${options.source}`,
    "",
    "## Mandatory",
    "",
    ...renderReadSetRows(readSet.mandatory),
    "",
    "## Recommended",
    "",
    ...renderReadSetRows(readSet.recommended),
    ""
  ].join("\n");
}

function discoverDocmapDocuments(rootInput: HarnessLayoutInput): ReadonlyArray<DocmapDocument> {
  const layout = resolveHarnessLayout(rootInput);
  const candidates = [
    path.join(layout.authoredRoot, "AGENTS.md"),
    path.join(layout.authoredRoot, "governance", "standards"),
    layout.adrRoot,
    layout.milestonesRoot
  ];
  const docs: DocmapDocument[] = [];
  for (const candidate of candidates) {
    collectMarkdownDocuments(layout.authoredRoot, candidate, docs);
  }
  const unique = new Map<string, DocmapDocument>();
  for (const doc of docs) unique.set(doc.path, doc);
  return [...unique.values()].sort(compareDocuments);
}

function collectMarkdownDocuments(authoredRoot: string, absolutePath: string, docs: DocmapDocument[]): void {
  if (!existsSync(absolutePath)) return;
  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolutePath)) {
      if (entry.startsWith(".")) continue;
      collectMarkdownDocuments(authoredRoot, path.join(absolutePath, entry), docs);
    }
    return;
  }
  if (!absolutePath.endsWith(".md")) return;
  const relativePath = normalizeRelativeDocumentPath(path.relative(authoredRoot, absolutePath).split(path.sep).join("/"));
  docs.push(documentFromMarkdown(absolutePath, relativePath, stat.mtime));
}

function documentFromMarkdown(absolutePath: string, relativePath: string, updatedAt: Date): DocmapDocument {
  const body = readFileSync(absolutePath, "utf8");
  const frontmatter = readFrontmatter(body);
  const pathParts = relativePath.split("/");
  const inferred = inferDocument(relativePath, pathParts);
  const modules = frontmatter ? readList(frontmatter, "modules", "docmap.modules") : [];
  const productLines = frontmatter ? readList(frontmatter, "productLines", "docmap.productLines") : [];
  const unused = frontmatter ? readBoolean(frontmatter, "unused", "docmap.unused") : false;
  return {
    id: firstNonEmpty(
      frontmatter ? readScalar(frontmatter, "docmap.id") : "",
      frontmatter ? readScalar(frontmatter, "id") : "",
      inferred.id
    ),
    path: relativePath,
    kind: inferred.kind,
    scope: {
      modules: modules.length > 0 ? modules : inferred.modules,
      productLines: productLines.length > 0 ? productLines : inferred.productLines
    },
    updatedAt: updatedAt.toISOString(),
    ...(unused ? { unused } : {})
  };
}

function inferDocument(relativePath: string, pathParts: ReadonlyArray<string>): {
  readonly id: string;
  readonly kind: DocmapDocument["kind"];
  readonly modules: ReadonlyArray<string>;
  readonly productLines: ReadonlyArray<string>;
} {
  if (relativePath === "AGENTS.md") {
    return { id: "operating:AGENTS", kind: "standard", modules: [], productLines: [] };
  }
  if (pathParts[0] === "governance" && pathParts[1] === "standards") {
    return { id: `standard:${basenameId(relativePath)}`, kind: "standard", modules: [], productLines: [] };
  }
  if (pathParts[0] === "adr") {
    return { id: `adr:${basenameId(relativePath)}`, kind: "adr", modules: [], productLines: [] };
  }
  if (pathParts[0] === "milestones") {
    const productLine = pathParts.length > 2 ? pathParts[1] ?? "" : "root";
    const moduleKey = pathParts.length > 3 ? pathParts[2] ?? "" : "";
    const context = [productLine, moduleKey, basenameId(relativePath)].filter(Boolean).join(":");
    return {
      id: `milestone:${context}`,
      kind: "roadmap",
      modules: moduleKey ? [moduleKey] : [],
      productLines: productLine === "root" ? [] : [productLine]
    };
  }
  return {
    id: `architecture:${basenameId(relativePath)}`,
    kind: "architecture",
    modules: inferModuleFromPath(pathParts),
    productLines: []
  };
}

function inferModuleFromPath(pathParts: ReadonlyArray<string>): ReadonlyArray<string> {
  const maybeModule = pathParts.find((part) => /^m\d[-\w]*$/iu.test(part));
  return maybeModule ? [maybeModule] : [];
}

function readList(frontmatter: string, ...keys: ReadonlyArray<string>): ReadonlyArray<string> {
  for (const key of keys) {
    const scalar = readScalar(frontmatter, key);
    if (scalar) return scalar.split(",").map((item) => item.trim()).filter(Boolean);
    const block = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\n((?:[ \\t]+- .*\\n?)*)`, "mu"))?.[1];
    if (block) {
      return block.split(/\r?\n/u)
        .map((line) => line.match(/^\s*-\s*(.*)$/u)?.[1]?.trim() ?? "")
        .filter(Boolean);
    }
  }
  return [];
}

function readBoolean(frontmatter: string, ...keys: ReadonlyArray<string>): boolean {
  for (const key of keys) {
    const value = readScalar(frontmatter, key).trim().toLowerCase();
    if (value === "true") return true;
  }
  return false;
}

function renderReadSetRows(documents: ReadonlyArray<DocmapDocument>): ReadonlyArray<string> {
  if (documents.length === 0) return ["- None."];
  return documents.map((document) => `- [${document.id}] ${document.path}`);
}

function basenameId(relativePath: string): string {
  return path.basename(relativePath, ".md").replace(/[^A-Za-z0-9_.:/@-]+/gu, "-");
}

function firstNonEmpty(...values: ReadonlyArray<string>): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? "";
}

function compareDocuments(left: DocmapDocument, right: DocmapDocument): number {
  return left.path.localeCompare(right.path, "en-US") || left.id.localeCompare(right.id, "en-US");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
