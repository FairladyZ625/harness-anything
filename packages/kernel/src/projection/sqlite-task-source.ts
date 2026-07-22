import { existsSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localProjectionSourceFileSystem } from "../local/local-layout-file-system.ts";
import { readFrontmatter } from "../markdown/frontmatter.ts";
import {
  deriveRelationTaskAuthoredSources,
  relationDecisionAuthoredSourceKind,
  type RelationAuthoredSourceKind
} from "./relation-source-manifest.ts";
import type { ProjectionWarning, TaskProjectionRow } from "./types.ts";
import {
  isSafeRelativeSourceCachePath,
  captureRequiredSourceCacheSignatures,
  captureSourceCacheWatchSignatures,
  listSourceCacheDirectoryPaths,
  restoreSourceCacheSignatures,
  sameSourceCacheSignatures,
  sourceCacheSignaturesMatch,
  serializeSourceCacheSignatures
} from "../local/persistent-source-cache-paths.ts";
import { readDirIfPresent, readDirNamesIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";
import { sourcePath, taskEntryToRow, type TaskSourceEntry } from "./sqlite-task-row.ts";

export { sourcePath, taskEntryToRow };
export type { TaskSourceEntry };

interface MarkdownSourceCacheEntry {
  readonly result: MarkdownSourceResult;
  readonly fileSignatures: ReadonlyMap<string, string>;
  readonly directorySignatures: ReadonlyMap<string, string | null>;
}

type MarkdownSourceResult = ReturnType<typeof markdownSourceResult>;

export interface MarkdownSourcePersistentCache {
  readonly schema: "markdown-source-cache/v1";
  readonly layoutIdentity: string;
  readonly result: {
    readonly entries: ReadonlyArray<{
      readonly taskId: string;
      readonly indexPath: string;
      readonly body: string;
      readonly frontmatter: string;
      readonly statSignature: string;
    }>;
    readonly hash: string;
    readonly warnings: ReadonlyArray<ProjectionWarning>;
    readonly sourceInputs: ReadonlyArray<TaskProjectionSourceHashInput>;
  };
  readonly fileSignatures: ReadonlyArray<{ readonly relativePath: string; readonly signature: string }>;
  readonly directorySignatures: ReadonlyArray<{ readonly relativePath: string; readonly signature: string | null }>;
}

export type PersistentSourceCacheRestore = "fresh" | "stale" | "invalid";

const markdownSourceCache = new Map<string, MarkdownSourceCacheEntry>();
const markdownSourceCacheLimit = 16;

export function captureMarkdownSourcePersistentCache(
  rootInput: HarnessLayoutInput,
  reuseCacheWithoutValidation = false
): MarkdownSourcePersistentCache | null {
  const layout = resolveHarnessLayout(rootInput);
  const cacheKey = markdownSourceCacheKey(layout);
  const cached = markdownSourceCache.get(cacheKey);
  if (!cached || (!reuseCacheWithoutValidation && !markdownSourceCacheEntryMatches(cached))) return null;
  return {
    schema: "markdown-source-cache/v1",
    layoutIdentity: cacheKey,
    result: {
      ...cached.result,
      entries: cached.result.entries.map((entry) => ({
        ...entry,
        indexPath: sourcePath(layout.rootDir, entry.indexPath)
      }))
    },
    fileSignatures: serializeSourceCacheSignatures(layout.rootDir, cached.fileSignatures),
    directorySignatures: serializeSourceCacheSignatures(layout.rootDir, cached.directorySignatures)
  };
}

export function restoreMarkdownSourcePersistentCache(
  rootInput: HarnessLayoutInput,
  persisted: MarkdownSourcePersistentCache
): PersistentSourceCacheRestore {
  if (!validPersistentMarkdownSource(persisted)) return "invalid";
  const layout = resolveHarnessLayout(rootInput);
  const cacheKey = markdownSourceCacheKey(layout);
  if (persisted.layoutIdentity !== cacheKey) return "stale";
  const entry: MarkdownSourceCacheEntry = {
    result: {
      ...persisted.result,
      entries: persisted.result.entries.map((source) => ({
        ...source,
        indexPath: path.resolve(layout.rootDir, source.indexPath)
      }))
    },
    fileSignatures: restoreSourceCacheSignatures(layout.rootDir, persisted.fileSignatures),
    directorySignatures: restoreSourceCacheSignatures(layout.rootDir, persisted.directorySignatures)
  };
  rememberMarkdownSourceCache(cacheKey, entry);
  return markdownSourceCacheEntryMatches(entry) ? "fresh" : "stale";
}

function validPersistentMarkdownSource(persisted: MarkdownSourcePersistentCache): boolean {
  if (persisted.schema !== "markdown-source-cache/v1" ||
      typeof persisted.layoutIdentity !== "string" ||
      !Array.isArray(persisted.result?.entries) ||
      !Array.isArray(persisted.result?.sourceInputs) ||
      !Array.isArray(persisted.fileSignatures) ||
      !Array.isArray(persisted.directorySignatures)) return false;
  if (persisted.result.sourceInputs.some((input) =>
    typeof input.kind !== "string" ||
    typeof input.sourcePath !== "string" ||
    !isSafeRelativeSourceCachePath(input.sourcePath) ||
    typeof input.body !== "string" ||
    typeof input.statSignature !== "string" ||
    (input.contentSha256 !== undefined &&
      (typeof input.contentSha256 !== "string" || sha256Text(input.body) !== input.contentSha256)))) return false;
  if (persisted.result.entries.some((entry) =>
    typeof entry.taskId !== "string" ||
    typeof entry.indexPath !== "string" ||
    !isSafeRelativeSourceCachePath(entry.indexPath) ||
    typeof entry.body !== "string" ||
    typeof entry.frontmatter !== "string" ||
    typeof entry.statSignature !== "string")) return false;
  if (persisted.fileSignatures.some((entry) =>
    !isSafeRelativeSourceCachePath(entry.relativePath) || typeof entry.signature !== "string")) return false;
  if (persisted.directorySignatures.some((entry) =>
    !isSafeRelativeSourceCachePath(entry.relativePath) ||
    (entry.signature !== null && typeof entry.signature !== "string"))) return false;
  if (hashTaskSourceInputs(persisted.result.sourceInputs) !== persisted.result.hash) return false;
  const bodiesByPath = new Map(persisted.result.sourceInputs.map((input) => [input.sourcePath, input.body]));
  return persisted.result.entries.every((entry) => bodiesByPath.get(entry.indexPath) === entry.body);
}

export function readMarkdownSource(
  rootInput: HarnessLayoutInput,
  validation: "stable" | "verify" = "stable",
  reuseCacheWithoutValidation = false,
  touchedPaths: ReadonlyArray<string> = [],
  validateReusedDirectories = true
): MarkdownSourceResult {
  const layout = resolveHarnessLayout(rootInput);
  const cacheKey = markdownSourceCacheKey(layout);
  const cached = markdownSourceCache.get(cacheKey);
  if (cached && touchedPaths.length > 0) {
    const refreshed = refreshMarkdownSourceCacheForTouchedPaths(layout, cacheKey, cached, touchedPaths);
    if (refreshed) return refreshed;
  }
  if (cached && (reuseCacheWithoutValidation
    ? !validateReusedDirectories || sourceCacheSignaturesMatch(cached.directorySignatures)
    : markdownSourceCacheEntryMatches(cached, validation))) {
    markdownSourceCache.delete(cacheKey);
    markdownSourceCache.set(cacheKey, cached);
    return cached.result;
  }
  const source = readTaskProjectionSource(rootInput, cached);
  const result = markdownSourceResult(source);
  const cacheEntry = createMarkdownSourceCacheEntry(layout, source, result);
  markdownSourceCache.delete(cacheKey);
  if (cacheEntry) rememberMarkdownSourceCache(cacheKey, cacheEntry);
  return result;
}

function refreshMarkdownSourceCacheForTouchedPaths(
  layout: ReturnType<typeof resolveHarnessLayout>,
  cacheKey: string,
  cached: MarkdownSourceCacheEntry,
  touchedPaths: ReadonlyArray<string>
): MarkdownSourceResult | null {
  const inputs = new Map(cached.result.sourceInputs.map((input) => [input.sourcePath, input]));
  const entries = new Map(cached.result.entries.map((entry) => [sourcePath(layout.rootDir, entry.indexPath), entry]));
  const fileSignatures = new Map(cached.fileSignatures);
  let changed = false;
  for (const touchedPath of touchedPaths) {
    const absolutePath = path.resolve(touchedPath);
    const relativePath = sourcePath(layout.rootDir, absolutePath);
    const existing = inputs.get(relativePath);
    if (!existing) return null;
    const currentSignature = localProjectionSourceFileSystem.statSignature(absolutePath);
    if (currentSignature === null) return null;
    if (currentSignature === existing.statSignature) continue;
    changed = true;
    const stable = localProjectionSourceFileSystem.readStableText(absolutePath);
    inputs.set(relativePath, {
      kind: existing.kind,
      sourcePath: relativePath,
      body: stable.body,
      statSignature: stable.signature,
      contentSha256: sha256Text(stable.body)
    });
    fileSignatures.set(path.resolve(layout.rootDir, relativePath), stable.signature);
    if (existing.kind === "task-index") {
      let frontmatter: string;
      try {
        frontmatter = parseFrontmatter(stable.body);
      } catch {
        return null;
      }
      const previous = entries.get(relativePath);
      entries.set(relativePath, {
        taskId: previous?.taskId ?? path.basename(path.dirname(absolutePath)),
        indexPath: absolutePath,
        body: stable.body,
        frontmatter,
        statSignature: stable.signature
      });
    }
  }
  if (!changed) {
    rememberMarkdownSourceCache(cacheKey, cached);
    return cached.result;
  }
  const orderedEntries = [...entries.values()].sort((left, right) => left.indexPath.localeCompare(right.indexPath));
  const taskIndexPaths = new Set(orderedEntries.map((entry) => sourcePath(layout.rootDir, entry.indexPath)));
  const sourceInputs = [
    ...orderedEntries.flatMap((entry) => {
      const input = inputs.get(sourcePath(layout.rootDir, entry.indexPath));
      return input ? [input] : [];
    }),
    ...[...inputs.values()]
      .filter((input) => !taskIndexPaths.has(input.sourcePath))
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  ];
  const result: MarkdownSourceResult = {
    entries: orderedEntries,
    hash: hashTaskSourceInputs(sourceInputs),
    warnings: cached.result.warnings,
    sourceInputs
  };
  rememberMarkdownSourceCache(cacheKey, {
    result,
    fileSignatures,
    directorySignatures: cached.directorySignatures
  });
  return result;
}

function markdownSourceCacheKey(layout: ReturnType<typeof resolveHarnessLayout>): string {
  return [layout.rootDir, layout.authoredRoot, layout.tasksRoot, layout.decisionsRoot].join("\0");
}

function rememberMarkdownSourceCache(cacheKey: string, entry: MarkdownSourceCacheEntry): void {
  markdownSourceCache.delete(cacheKey);
  markdownSourceCache.set(cacheKey, entry);
  while (markdownSourceCache.size > markdownSourceCacheLimit) {
    const oldest = markdownSourceCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    markdownSourceCache.delete(oldest);
  }
}

function markdownSourceResult(source: ReturnType<typeof readTaskProjectionSource>): {
  readonly entries: ReadonlyArray<TaskSourceEntry>;
  readonly hash: string;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
  readonly sourceInputs: ReadonlyArray<TaskProjectionSourceHashInput>;
} {
  return {
    entries: source.entries,
    hash: hashTaskSourceInputs(source.sourceInputs),
    warnings: source.warnings,
    sourceInputs: source.sourceInputs
  };
}

function createMarkdownSourceCacheEntry(
  layout: ReturnType<typeof resolveHarnessLayout>,
  source: ReturnType<typeof readTaskProjectionSource>,
  result: ReturnType<typeof markdownSourceResult>
): MarkdownSourceCacheEntry | null {
  const files = new Map(source.sourceInputs.map((input) => [
    path.join(layout.rootDir, input.sourcePath),
    input.body
  ]));
  const directories = new Set([
    layout.authoredRoot,
    layout.tasksRoot,
    layout.decisionsRoot,
    ...source.taskPackagePaths,
    ...source.entries.map((entry) => path.dirname(entry.indexPath)),
    ...[...files.keys()].map(path.dirname),
    ...listSourceCacheDirectoryPaths(layout.decisionsRoot)
  ]);
  const beforeFiles = captureRequiredSourceCacheSignatures(files.keys());
  const beforeDirectories = captureSourceCacheWatchSignatures(directories);
  if (beforeFiles === null) return null;
  const afterFiles = captureRequiredSourceCacheSignatures(files.keys());
  const afterDirectories = captureSourceCacheWatchSignatures(directories);
  if (afterFiles === null ||
      !sameSourceCacheSignatures(beforeFiles, afterFiles) ||
      !sameSourceCacheSignatures(beforeDirectories, afterDirectories) ||
      source.sourceInputs.some((input) =>
        afterFiles.get(path.join(layout.rootDir, input.sourcePath)) !== input.statSignature)) return null;
  return {
    result,
    fileSignatures: afterFiles,
    directorySignatures: afterDirectories
  };
}

function markdownSourceCacheEntryMatches(
  entry: MarkdownSourceCacheEntry,
  validation: "stable" | "verify" = "stable"
): boolean {
  const signatures = new Map<string, string | null>([...entry.directorySignatures, ...entry.fileSignatures]);
  return sourceCacheSignaturesMatch(signatures) &&
    (validation === "verify" || sourceCacheSignaturesMatch(signatures));
}

function reusableSourceBodies(
  rootDir: string,
  reusable: MarkdownSourceCacheEntry | undefined
): ReadonlyMap<string, string> {
  if (!reusable) return new Map();
  return new Map(reusable.result.sourceInputs.map((input) => [
    path.resolve(rootDir, input.sourcePath),
    input.body
  ]));
}

function readReusableSourceText(
  filePath: string,
  reusableBodies: ReadonlyMap<string, string>,
  reusableSignatures: ReadonlyMap<string, string> | undefined
): { readonly body: string; readonly signature: string } | null {
  const currentSignature = localProjectionSourceFileSystem.statSignature(filePath);
  if (currentSignature === null) return null;
  const reusableBody = reusableBodies.get(filePath);
  if (reusableBody !== undefined && reusableSignatures?.get(filePath) === currentSignature) {
    return { body: reusableBody, signature: currentSignature };
  }
  try {
    return localProjectionSourceFileSystem.readStableText(filePath);
  } catch {
    return null;
  }
}

export function readTaskProjectionSourceHashInputs(rootInput: HarnessLayoutInput): ReadonlyArray<TaskProjectionSourceHashInput> {
  return readTaskProjectionSource(rootInput).sourceInputs;
}

export function readRelationGraphSourceHashInputKinds(rootInput: HarnessLayoutInput): ReadonlyArray<RelationAuthoredSourceKind> {
  return [...new Set(readTaskProjectionSource(rootInput).relationSourceInputs.map((input) => input.kind))].sort();
}

function readTaskProjectionSource(rootInput: HarnessLayoutInput, reusable?: MarkdownSourceCacheEntry): {
  readonly entries: ReadonlyArray<TaskSourceEntry>;
  readonly taskPackagePaths: ReadonlyArray<string>;
  readonly sourceInputs: ReadonlyArray<TaskProjectionSourceHashInput>;
  readonly relationSourceInputs: ReadonlyArray<RelationSourceHashInput>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
} {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const tasksDir = layout.tasksRoot;
  const warnings: ProjectionWarning[] = [];
  const entries: TaskSourceEntry[] = [];
  const reusableBodies = reusableSourceBodies(rootDir, reusable);
  const taskEntries = existsSync(tasksDir) ? readDirNamesIfPresent(tasksDir) : [];
  const taskPackagePaths = (taskEntries ?? [])
    .map((name) => path.join(tasksDir, name))
    .filter((inputPath) => statPathIfPresent(inputPath)?.isDirectory());
  for (const name of (taskEntries ?? []).sort()) {
    const indexPath = path.join(tasksDir, name, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const sourceText = readReusableSourceText(indexPath, reusableBodies, reusable?.fileSignatures);
    if (sourceText === null) continue;
    try {
      entries.push({
        taskId: name,
        indexPath,
        body: sourceText.body,
        frontmatter: parseFrontmatter(sourceText.body),
        statSignature: sourceText.signature
      });
    } catch (error) {
      warnings.push({
        code: "source_malformed",
        source: "source-package",
        severity: "hard-fail",
        message: error instanceof Error ? error.message : `Malformed task package: ${name}`,
        repairHint: "Restore valid task-package/v2 frontmatter before running projection reads or post-merge checks."
      });
    }
  }

  const relationSourceInputs = readRelationGraphSourceInputs(rootDir, layout, entries, reusableBodies, reusable?.fileSignatures);
  const supplementalSourceInputs = readTaskSupplementalSourceInputs(rootDir, entries, reusableBodies, reusable?.fileSignatures);
  const taskIndexInputs = entries.flatMap((entry) => relationSourceInputs.filter((input) =>
    input.kind === "task-index" && input.taskId === entry.taskId
  ));
  const remainingSourceInputs = [
    ...relationSourceInputs.filter((input) => input.kind !== "task-index"),
    ...supplementalSourceInputs
  ].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return {
    entries,
    taskPackagePaths,
    sourceInputs: [...taskIndexInputs, ...remainingSourceInputs],
    relationSourceInputs,
    warnings
  };
}

export interface TaskProjectionSourceHashInput {
  readonly kind: string;
  readonly sourcePath: string;
  readonly body: string;
  readonly statSignature: string;
  readonly contentSha256?: string;
}

interface RelationSourceHashInput extends TaskProjectionSourceHashInput {
  readonly kind: RelationAuthoredSourceKind;
  readonly taskId?: string;
}

function parseFrontmatter(body: string): string {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw new Error("INDEX.md missing frontmatter");
  return frontmatter;
}

function readRelationGraphSourceInputs(
  rootDir: string,
  layout: ReturnType<typeof resolveHarnessLayout>,
  entries: ReadonlyArray<TaskSourceEntry>,
  reusableBodies: ReadonlyMap<string, string>,
  reusableSignatures: ReadonlyMap<string, string> | undefined
): ReadonlyArray<RelationSourceHashInput> {
  const taskDocumentInputs = entries
    .flatMap((entry) => deriveRelationTaskAuthoredSources(path.dirname(entry.indexPath)).map((source) => ({
      kind: source.kind,
      path: source.filePath,
      ...(source.kind === "task-index" ? { taskId: entry.taskId } : {}),
      ...(source.filePath === entry.indexPath ? { body: entry.body, statSignature: entry.statSignature } : {})
    })))
    .filter((input) => input.body !== undefined || existsSync(input.path))
    .flatMap((input) => {
      const sourceText = input.body === undefined
        ? readReusableSourceText(input.path, reusableBodies, reusableSignatures)
        : { body: input.body, signature: input.statSignature! };
      return sourceText === null
        ? []
        : [{
          kind: input.kind,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          sourcePath: sourcePath(rootDir, input.path),
          body: sourceText.body,
          statSignature: sourceText.signature,
          contentSha256: sha256Text(sourceText.body)
        }];
    });
  const decisionInputs = listDecisionDocuments(layout.decisionsRoot)
    .flatMap((decisionPath) => {
      const kind = relationDecisionAuthoredSourceKind(decisionPath);
      if (kind === null) return [];
      const sourceText = readReusableSourceText(decisionPath, reusableBodies, reusableSignatures);
      return sourceText === null
        ? []
        : [{
          kind,
          sourcePath: sourcePath(rootDir, decisionPath),
          body: sourceText.body,
          statSignature: sourceText.signature,
          contentSha256: sha256Text(sourceText.body)
        }];
    });
  return [...taskDocumentInputs, ...decisionInputs];
}

function readTaskSupplementalSourceInputs(
  rootDir: string,
  entries: ReadonlyArray<TaskSourceEntry>,
  reusableBodies: ReadonlyMap<string, string>,
  reusableSignatures: ReadonlyMap<string, string> | undefined
): ReadonlyArray<TaskProjectionSourceHashInput> {
  return entries
    .flatMap((entry) => [
      { kind: "task-module", path: path.join(path.dirname(entry.indexPath), "module.md") },
      { kind: "task-review", path: path.join(path.dirname(entry.indexPath), "review.md") },
      { kind: "task-closeout", path: path.join(path.dirname(entry.indexPath), "closeout.md") }
    ])
    .filter((input) => existsSync(input.path))
    .flatMap((input) => {
      const sourceText = readReusableSourceText(input.path, reusableBodies, reusableSignatures);
      return sourceText === null
        ? []
        : [{
          kind: input.kind,
          sourcePath: sourcePath(rootDir, input.path),
          body: sourceText.body,
          statSignature: sourceText.signature,
          contentSha256: sha256Text(sourceText.body)
        }];
    });
}

function listDecisionDocuments(decisionsRoot: string): ReadonlyArray<string> {
  if (!existsSync(decisionsRoot)) return [];
  const stat = statPathIfPresent(decisionsRoot);
  if (stat === null) return [];
  if (stat.isFile()) return relationDecisionAuthoredSourceKind(decisionsRoot) === null ? [] : [decisionsRoot];
  if (!stat.isDirectory()) return [];
  const entries = readDirIfPresent(decisionsRoot);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .flatMap((entry) => listDecisionDocuments(path.join(decisionsRoot, entry.name)))
    .sort();
}

export function hashExactRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashExactSortedRows([...rows].sort(compareRows));
}

export function hashExactSortedRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify(rows.map(canonicalTaskProjectionRow)));
}

export function hashTaskProjectionRows(rows: ReadonlyArray<TaskProjectionRow>): string {
  return hashText(JSON.stringify([...rows].sort(compareRows).map((row) => canonicalTaskProjectionRow({
    ...row,
    updatedAt: "<derived-from-source-mtime>"
  }))));
}

function hashText(text: string): string {
  return `sha256:${sha256Text(text)}`;
}

function hashTaskSourceInputs(inputs: ReadonlyArray<TaskProjectionSourceHashInput>): string {
  return hashText(JSON.stringify({
    schema: "task-projection-source/v2",
    inputs: inputs.map(({ kind, sourcePath: inputPath, body, contentSha256 }) => ({
      kind,
      sourcePath: inputPath,
      contentSha256: contentSha256 ?? sha256Text(body)
    }))
  }));
}

export function compareRows(a: TaskProjectionRow, b: TaskProjectionRow): number {
  return a.taskId.localeCompare(b.taskId);
}

function canonicalTaskProjectionRow(row: TaskProjectionRow): Omit<TaskProjectionRow, "attribution" | "createdAt" | "treeRoot" | "liveness" | "terminalAt"> {
  return {
    schema: row.schema,
    taskId: row.taskId,
    title: row.title,
    ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
    canonicalStatus: row.canonicalStatus,
    coordinationStatus: row.coordinationStatus,
    rawStatus: row.rawStatus,
    packageDisposition: row.packageDisposition,
    closeoutReadiness: row.closeoutReadiness,
    lifecycleEngine: row.lifecycleEngine,
    freshness: row.freshness,
    updatedAt: row.updatedAt,
    source: row.source,
    sourcePath: row.sourcePath,
    ...(row.vertical ? { vertical: row.vertical } : {}),
    ...(row.preset ? { preset: row.preset } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.workKind ? { workKind: row.workKind } : {}),
    ...(row.riskTier ? { riskTier: row.riskTier } : {}),
    ...(row.urgency ? { urgency: row.urgency } : {}),
    ...(row.moduleKey ? { moduleKey: row.moduleKey } : {}),
    ...(row.moduleTitle ? { moduleTitle: row.moduleTitle } : {}),
    ...(row.hasLessonCandidates === undefined ? {} : { hasLessonCandidates: row.hasLessonCandidates }),
    ...(row.fieldExtensions ? { fieldExtensions: sortRecord(row.fieldExtensions) } : {})
  };
}

function sortRecord(record: Readonly<Record<string, string | null>>): Readonly<Record<string, string | null>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
