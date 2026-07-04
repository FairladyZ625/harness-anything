import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import type { DocmapDocument, DocmapManifest, DocmapReadSet } from "../../../../kernel/src/domain/docmap.ts";
import { buildDocmapReadSet, docmapManifestPath } from "../../../../kernel/src/docmap/index.ts";
import { assertUniqueDocmapIds } from "../../../../kernel/src/docmap/docmap-unique.ts";
import { readFrontmatter, readScalar } from "../../../../kernel/src/markdown/frontmatter.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { DocmapManifestSchema } from "../../../../kernel/src/schemas/docmap.ts";
import { authoredRelativePath, commitAuthoredPaths, type AuthoredGitCommitResult } from "./authored-git.ts";

export interface DerivedDocmapResult {
  readonly manifest: DocmapManifest;
  readonly path: string;
  readonly relativePath: string;
}

export interface WrittenDocmapResult extends DerivedDocmapResult {
  readonly git: AuthoredGitCommitResult;
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

export function writeDerivedDocmapManifest(rootInput: HarnessLayoutInput): WrittenDocmapResult {
  const derived = deriveDocmapManifest(rootInput);
  mkdirSync(path.dirname(derived.path), { recursive: true });
  const tmpPath = `${derived.path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(derived.manifest, null, 2)}\n`, "utf8");
  renameSync(tmpPath, derived.path);
  const git = commitAuthoredPaths(rootInput, [authoredRelativePath(rootInput, derived.path)], "doc(generate): docmap.json");
  return { ...derived, git };
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
  docs.push(documentFromMarkdown(absolutePath, relativePath));
}

function documentFromMarkdown(absolutePath: string, relativePath: string): DocmapDocument {
  const body = readFileSync(absolutePath, "utf8");
  const frontmatter = readFrontmatter(body);
  const pathParts = relativePath.split("/");
  const inferred = inferDocument(relativePath, pathParts, body);
  const modules = frontmatter ? readList(frontmatter, "modules", "docmap.modules") : [];
  const productLines = frontmatter ? readList(frontmatter, "productLines", "docmap.productLines") : [];
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
    owner: firstNonEmpty(frontmatter ? readScalar(frontmatter, "owner") : "", inferred.owner),
    brief: firstNonEmpty(frontmatter ? readScalar(frontmatter, "brief") : "", firstHeading(body), inferred.brief),
    tags: ["derived", ...inferred.tags]
  };
}

function inferDocument(relativePath: string, pathParts: ReadonlyArray<string>, body: string): {
  readonly id: string;
  readonly kind: DocmapDocument["kind"];
  readonly modules: ReadonlyArray<string>;
  readonly productLines: ReadonlyArray<string>;
  readonly owner: string;
  readonly brief: string;
  readonly tags: ReadonlyArray<string>;
} {
  if (relativePath === "AGENTS.md") {
    return { id: "operating:AGENTS", kind: "standard", modules: [], productLines: [], owner: "operations", brief: "Local operating entrypoint", tags: ["operating"] };
  }
  if (pathParts[0] === "governance" && pathParts[1] === "standards") {
    return { id: `standard:${basenameId(relativePath)}`, kind: "standard", modules: [], productLines: [], owner: "governance", brief: titleFromPath(relativePath, body), tags: ["governance"] };
  }
  if (pathParts[0] === "adr") {
    return { id: `adr:${basenameId(relativePath)}`, kind: "adr", modules: [], productLines: [], owner: "architecture", brief: titleFromPath(relativePath, body), tags: ["adr"] };
  }
  if (pathParts[0] === "milestones") {
    const productLine = pathParts.length > 2 ? pathParts[1] ?? "" : "root";
    const moduleKey = pathParts.length > 3 ? pathParts[2] ?? "" : "";
    const context = [productLine, moduleKey, basenameId(relativePath)].filter(Boolean).join(":");
    return {
      id: `milestone:${context}`,
      kind: "roadmap",
      modules: moduleKey ? [moduleKey] : [],
      productLines: productLine === "root" ? [] : [productLine],
      owner: "architecture",
      brief: titleFromPath(relativePath, body),
      tags: ["milestone"]
    };
  }
  return {
    id: `architecture:${basenameId(relativePath)}`,
    kind: "architecture",
    modules: inferModuleFromPath(pathParts),
    productLines: [],
    owner: "architecture",
    brief: titleFromPath(relativePath, body),
    tags: ["architecture"]
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

function renderReadSetRows(documents: ReadonlyArray<DocmapDocument>): ReadonlyArray<string> {
  if (documents.length === 0) return ["- None."];
  return documents.map((document) => `- [${document.id}] ${document.path} - ${document.brief}`);
}

function firstHeading(body: string): string {
  return body.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? "";
}

function titleFromPath(relativePath: string, body: string): string {
  return firstHeading(body) || basenameId(relativePath).replace(/[-_]+/gu, " ");
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
