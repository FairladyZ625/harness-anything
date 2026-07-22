import path from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import type {
  EntityDeclaration
} from "../entity/declaration.ts";
import { readField, resolveEntityDocumentPath } from "../entity/declaration.ts";
import type { EntityProjectionColumnDeclaration } from "../entity/registry.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { sha256Text, stablePayloadHash } from "../integrity/stable-hash.ts";
import {
  localLayoutFileSystem,
  localProjectionSourceFileSystem,
  localRuntimeStateFileSystem
} from "../local/local-layout-file-system.ts";
import { quoteIdentifier, runSqlite, runSqliteReadonly } from "./sqlite-projection-store.ts";

export type DeclaredProjectionValue = string | number | null;
export type DeclaredProjectionRow = Readonly<Record<string, DeclaredProjectionValue>>;

export interface DeclaredProjectionResult {
  readonly table: string;
  readonly rows: ReadonlyArray<DeclaredProjectionRow>;
}

export interface DeclaredEntityDiscoveryStats {
  readonly directoriesVisited: number;
  readonly entriesVisited: number;
  readonly filesMatched: number;
  readonly cacheHit: boolean;
}

export interface DeclaredEntityDiscoveryResult {
  readonly rows: ReadonlyArray<DeclaredProjectionRow>;
  readonly documents: ReadonlyArray<DeclaredEntityDocumentProjection>;
  readonly stats: DeclaredEntityDiscoveryStats;
}

export interface DeclaredEntityDocumentProjection {
  readonly relativePath: string;
  readonly sourceHash: string;
  readonly statSignature: string;
  readonly primaryKey: string;
  readonly row: DeclaredProjectionRow;
}

export interface DeclaredEntitySourceInput {
  readonly relativePath: string;
  readonly body?: string;
  readonly statSignature: string;
  readonly contentSha256: string;
}

export interface DeclaredEntitySourceHint {
  readonly sourcePath: string;
  readonly sourceKind: string;
  readonly statSignature: string;
  readonly contentSha256: string;
}

export interface DeclaredEntitySourceResult {
  readonly inputs: ReadonlyArray<DeclaredEntitySourceInput>;
  readonly hash: string;
  readonly stats: DeclaredEntityDiscoveryStats;
}

interface DeclaredEntitySourceCacheEntry {
  readonly result: DeclaredEntitySourceResult;
  readonly directorySignatures: ReadonlyMap<string, string>;
  readonly fileSignatures: ReadonlyMap<string, string>;
}

const declaredEntitySourceCache = new Map<string, DeclaredEntitySourceCacheEntry>();
const declaredEntitySourceCacheLimit = 32;

export function projectDeclaredEntities(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  projectionPath: string
): DeclaredProjectionResult {
  const rows = discoverDeclaredEntityRows(rootInput, declaration);
  return projectDeclaredEntityRows(declaration, projectionPath, rows);
}

export function projectDeclaredEntityRows(
  declaration: EntityDeclaration,
  projectionPath: string,
  rows: ReadonlyArray<DeclaredProjectionRow>
): DeclaredProjectionResult {
  localRuntimeStateFileSystem.mkdirp(path.dirname(projectionPath));
  runSqlite(projectionPath, Effect.flatMap(SqlClient.SqlClient, (sql) =>
    replaceDeclaredProjectionRows(sql, declaration, rows)));
  return { table: declaration.projection.table, rows };
}

export function replaceDeclaredProjectionRows(
  sql: SqlClient.SqlClient,
  declaration: EntityDeclaration,
  rows: ReadonlyArray<DeclaredProjectionRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(declaration.projection.table)}`);
    yield* sql.unsafe(createTableSql(declaration));
    for (const batch of chunks(rows, 500)) yield* insertRows(sql, declaration, batch);
  });
}

export function readDeclaredProjectionRows(
  projectionPath: string,
  declaration: EntityDeclaration
): ReadonlyArray<DeclaredProjectionRow> {
  return runSqliteReadonly(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = declaration.projection.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const primaryKey = declaration.projection.columns.find((column) => column.primaryKey)!;
    return yield* sql.unsafe<DeclaredProjectionRow>(
      `SELECT ${columns} FROM ${quoteIdentifier(declaration.projection.table)} ORDER BY ${quoteIdentifier(primaryKey.name)}`
    );
  }));
}

export function discoverDeclaredEntityRows(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration
): ReadonlyArray<DeclaredProjectionRow> {
  return discoverDeclaredEntityProjection(rootInput, declaration).rows;
}

export function discoverDeclaredEntityProjection(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration
): DeclaredEntityDiscoveryResult {
  return projectDeclaredEntitySource(rootInput, declaration, readDeclaredEntitySource(rootInput, declaration));
}

export function readDeclaredEntitySource(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  hints: ReadonlyArray<DeclaredEntitySourceHint> = [],
  validation: "stable" | "verify" = "stable",
  touchedPaths: ReadonlyArray<string> = [],
  reuseCacheWithoutValidation = false,
  validateReusedDirectories = true
): DeclaredEntitySourceResult {
  if (touchedPaths.length > 0) {
    return readDeclaredEntitySourceFromTouchedPaths(rootInput, declaration, hints, touchedPaths);
  }
  if (reuseCacheWithoutValidation) {
    const layout = resolveHarnessLayout(rootInput);
    const cacheKey = `${layout.authoredRoot}\0${declaration.kind}\0${declaration.rootResolver.pathTemplate}`;
    const cached = declaredEntitySourceCache.get(cacheKey);
    if (cached && (!validateReusedDirectories || pathSignaturesMatch(cached.directorySignatures))) {
      return { ...cached.result, stats: { ...cached.result.stats, cacheHit: true } };
    }
  }
  return readDeclaredEntitySourceAttempt(rootInput, declaration, hints, validation, 0);
}

function readDeclaredEntitySourceFromTouchedPaths(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  hints: ReadonlyArray<DeclaredEntitySourceHint>,
  touchedPaths: ReadonlyArray<string>
): DeclaredEntitySourceResult {
  const layout = resolveHarnessLayout(rootInput);
  const cacheKey = `${layout.authoredRoot}\0${declaration.kind}\0${declaration.rootResolver.pathTemplate}`;
  const cached = declaredEntitySourceCache.get(cacheKey);
  const matcher = templateMatcher(declaration.rootResolver.pathTemplate);
  const inputs = new Map<string, DeclaredEntitySourceInput>(hints
    .filter((hint) => hint.sourceKind === declaration.kind)
    .map((hint) => [hint.sourcePath, {
      relativePath: hint.sourcePath,
      statSignature: hint.statSignature,
      contentSha256: hint.contentSha256
    }]));
  let matchedPaths = 0;
  for (const touchedPath of touchedPaths) {
    const relativePath = path.relative(layout.authoredRoot, path.resolve(touchedPath)).split(path.sep).join("/");
    if (relativePath === ".." || relativePath.startsWith("../") || !matcher.pattern.test(relativePath)) continue;
    matchedPaths += 1;
    const documentPath = path.join(layout.authoredRoot, relativePath);
    if (!localLayoutFileSystem.exists(documentPath)) {
      inputs.delete(relativePath);
      continue;
    }
    const stable = localProjectionSourceFileSystem.readStableText(documentPath);
    inputs.set(relativePath, {
      relativePath,
      body: stable.body,
      statSignature: stable.signature,
      contentSha256: sha256Text(stable.body)
    });
  }
  const current = [...inputs.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const result: DeclaredEntitySourceResult = {
    inputs: current,
    hash: stablePayloadHash({
      schema: "declared-entity-source/v1",
      kind: declaration.kind,
      inputs: current.map(({ relativePath, contentSha256 }) => ({ relativePath, contentSha256 }))
    }),
    stats: {
      directoriesVisited: 0,
      entriesVisited: matchedPaths,
      filesMatched: current.length,
      cacheHit: true
    }
  };
  const cachedPaths = new Set(cached?.result.inputs.map((input) => input.relativePath) ?? []);
  if (cached && cachedPaths.size === current.length && current.every((input) => cachedPaths.has(input.relativePath))) {
    const currentByPath = new Map(current.map((input) => [input.relativePath, input]));
    const refreshedInputs = cached.result.inputs.map((input) => {
      const refreshed = currentByPath.get(input.relativePath)!;
      return refreshed.body === undefined ? input : refreshed;
    });
    const fileSignatures = new Map(cached.fileSignatures);
    for (const input of current) {
      if (input.body !== undefined) {
        fileSignatures.set(path.join(layout.authoredRoot, input.relativePath), input.statSignature);
      }
    }
    declaredEntitySourceCache.delete(cacheKey);
    declaredEntitySourceCache.set(cacheKey, {
      result: { ...result, inputs: refreshedInputs },
      directorySignatures: cached.directorySignatures,
      fileSignatures
    });
    evictDeclaredEntitySourceCache();
  }
  return result;
}

function readDeclaredEntitySourceAttempt(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  hints: ReadonlyArray<DeclaredEntitySourceHint>,
  validation: "stable" | "verify",
  attempt: number
): DeclaredEntitySourceResult {
  const layout = resolveHarnessLayout(rootInput);
  const cacheKey = `${layout.authoredRoot}\0${declaration.kind}\0${declaration.rootResolver.pathTemplate}`;
  const cached = declaredEntitySourceCache.get(cacheKey);
  const cachedBodiesAvailable = cached?.result.inputs.every((input) => input.body !== undefined) ?? false;
  if (cached && (hints.length > 0 || cachedBodiesAvailable) && sourceCacheEntryMatches(cached, validation)) {
    declaredEntitySourceCache.delete(cacheKey);
    declaredEntitySourceCache.set(cacheKey, cached);
    return {
      ...cached.result,
      stats: { ...cached.result.stats, cacheHit: true }
    };
  }
  const matcher = templateMatcher(declaration.rootResolver.pathTemplate);
  let discovered: ReturnType<typeof listTemplateFiles>;
  try {
    discovered = listTemplateFiles(layout.authoredRoot, declaration.rootResolver.pathTemplate);
  } catch {
    return retryDeclaredEntitySource(rootInput, declaration, hints, validation, cacheKey, attempt, declaration.kind);
  }
  const hintsByPath = new Map(hints
    .filter((hint) => hint.sourceKind === declaration.kind)
    .map((hint) => [hint.sourcePath, hint]));
  const inputs: DeclaredEntitySourceInput[] = [];
  for (const relativePath of discovered.files) {
    const match = matcher.pattern.exec(relativePath);
    if (!match) continue;
    const identity = Object.fromEntries(matcher.keys.map((key, index) => [key, match[index + 1]!]));
    resolveEntityDocumentPath(rootInput, declaration, identity);
    const documentPath = path.join(layout.authoredRoot, relativePath);
    const statSignature = localProjectionSourceFileSystem.statSignature(documentPath);
    if (statSignature === null) {
      return retryDeclaredEntitySource(rootInput, declaration, hints, validation, cacheKey, attempt, relativePath);
    }
    const hint = hintsByPath.get(relativePath);
    if (hint?.statSignature === statSignature) {
      inputs.push({ relativePath, statSignature, contentSha256: hint.contentSha256 });
      continue;
    }
    let stable: ReturnType<typeof localProjectionSourceFileSystem.readStableText>;
    try {
      stable = localProjectionSourceFileSystem.readStableText(documentPath);
    } catch {
      return retryDeclaredEntitySource(rootInput, declaration, hints, validation, cacheKey, attempt, relativePath);
    }
    inputs.push({
      relativePath,
      body: stable.body,
      statSignature: stable.signature,
      contentSha256: sha256Text(stable.body)
    });
  }
  const fileSignatures = new Map(inputs.map((input) => [
    path.join(layout.authoredRoot, input.relativePath),
    input.statSignature
  ]));
  if (!pathSignaturesMatch(discovered.directorySignatures) || !pathSignaturesMatch(fileSignatures)) {
    declaredEntitySourceCache.delete(cacheKey);
    if (attempt >= 2) throw new Error(`declared entity source did not stabilize: ${declaration.kind}`);
    return readDeclaredEntitySourceAttempt(rootInput, declaration, hints, validation, attempt + 1);
  }
  const result: DeclaredEntitySourceResult = {
    inputs,
    hash: stablePayloadHash({
      schema: "declared-entity-source/v1",
      kind: declaration.kind,
      inputs: inputs.map(({ relativePath, contentSha256 }) => ({ relativePath, contentSha256 }))
    }),
    stats: {
      directoriesVisited: discovered.directoriesVisited,
      entriesVisited: discovered.entriesVisited,
      filesMatched: inputs.length,
      cacheHit: false
    }
  };
  const directorySignatures = discovered.directorySignatures;
  if (directorySignatures.size > 0 || fileSignatures.size > 0) {
    declaredEntitySourceCache.delete(cacheKey);
    declaredEntitySourceCache.set(cacheKey, { result, directorySignatures, fileSignatures });
    evictDeclaredEntitySourceCache();
  } else {
    declaredEntitySourceCache.delete(cacheKey);
  }
  return result;
}

export function projectDeclaredEntitySource(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  source: DeclaredEntitySourceResult
): DeclaredEntityDiscoveryResult {
  const matcher = templateMatcher(declaration.rootResolver.pathTemplate);
  const documents: DeclaredEntityDocumentProjection[] = [];
  const primaryKey = declaration.projection.columns.find((column) => column.primaryKey)!;
  for (const input of source.inputs) {
    const match = matcher.pattern.exec(input.relativePath);
    if (!match) continue;
    const identity = Object.fromEntries(matcher.keys.map((key, index) => [key, match[index + 1]!]));
    resolveEntityDocumentPath(rootInput, declaration, identity);
    if (input.body === undefined) throw new Error(`declared entity source body was not loaded: ${input.relativePath}`);
    const raw = declaration.documentCodec.decode(input.body);
    if (raw === undefined) continue;
    const decoded = Schema.decodeUnknownSync(declaration.schema)(raw) as Readonly<Record<string, unknown>>;
    const row = projectRow(decoded, declaration.projection.columns);
    const identityKey = declaration.rootResolver.identity.at(-1)!;
    const expectedPrimaryKey = identity[identityKey];
    const actualPrimaryKey = String(row[primaryKey.name]);
    if (expectedPrimaryKey !== actualPrimaryKey) {
      throw new Error(`declared entity path identity ${expectedPrimaryKey} does not match projected identity ${actualPrimaryKey}: ${input.relativePath}`);
    }
    documents.push({
      relativePath: input.relativePath,
      sourceHash: input.contentSha256,
      statSignature: input.statSignature,
      primaryKey: actualPrimaryKey,
      row
    });
  }
  documents.sort((left, right) => left.primaryKey.localeCompare(right.primaryKey));
  return {
    rows: documents.map((document) => document.row),
    documents,
    stats: source.stats
  };
}

function retryDeclaredEntitySource(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  hints: ReadonlyArray<DeclaredEntitySourceHint>,
  validation: "stable" | "verify",
  cacheKey: string,
  attempt: number,
  relativePath: string
): DeclaredEntitySourceResult {
  declaredEntitySourceCache.delete(cacheKey);
  if (attempt >= 2) throw new Error(`declared entity source did not stabilize: ${relativePath}`);
  return readDeclaredEntitySourceAttempt(rootInput, declaration, hints, validation, attempt + 1);
}

export function deleteDeclaredProjectionRows(
  sql: SqlClient.SqlClient,
  declaration: EntityDeclaration,
  primaryKeys: ReadonlyArray<string>
): Effect.Effect<void, unknown> {
  const primaryKey = declaration.projection.columns.find((column) => column.primaryKey)!;
  return Effect.gen(function* () {
    for (const value of [...new Set(primaryKeys)]) {
      yield* sql.unsafe(
        `DELETE FROM ${quoteIdentifier(declaration.projection.table)} WHERE ${quoteIdentifier(primaryKey.name)} = ?`,
        [value]
      );
    }
  });
}

export function upsertDeclaredProjectionRows(
  sql: SqlClient.SqlClient,
  declaration: EntityDeclaration,
  rows: ReadonlyArray<DeclaredProjectionRow>
): Effect.Effect<void, unknown> {
  const primaryKey = declaration.projection.columns.find((column) => column.primaryKey)!;
  const columns = declaration.projection.columns.map((column) => quoteIdentifier(column.name));
  const placeholders = columns.map(() => "?").join(", ");
  const assignments = declaration.projection.columns
    .filter((column) => !column.primaryKey)
    .map((column) => `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`)
    .join(", ");
  const conflictClause = assignments.length > 0
    ? `DO UPDATE SET ${assignments}`
    : "DO NOTHING";
  return Effect.gen(function* () {
    for (const row of rows) {
      const values = declaration.projection.columns.map((column) => row[column.name] ?? null);
      yield* sql.unsafe(
        `INSERT INTO ${quoteIdentifier(declaration.projection.table)} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdentifier(primaryKey.name)}) ${conflictClause}`,
        values
      );
    }
  });
}

function projectRow(
  entity: Readonly<Record<string, unknown>>,
  columns: ReadonlyArray<EntityProjectionColumnDeclaration>
): DeclaredProjectionRow {
  return Object.fromEntries(columns.map((column) => [column.name, projectValue(readField(entity, column.field), column)]));
}

function projectValue(value: unknown, column: EntityProjectionColumnDeclaration): DeclaredProjectionValue {
  if (value === undefined || value === null) return null;
  if (column.type === "json") return JSON.stringify(value);
  if (column.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`projection field ${column.field} must be boolean`);
    return value ? 1 : 0;
  }
  if (column.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`projection field ${column.field} must be an integer`);
    return value as number;
  }
  if (typeof value !== "string") throw new Error(`projection field ${column.field} must be text`);
  return value;
}

function createTableSql(declaration: EntityDeclaration): string {
  const columns = declaration.projection.columns.map((column) => {
    const primaryKey = column.primaryKey ? " PRIMARY KEY" : "";
    return `${quoteIdentifier(column.name)} ${sqliteType(column.type)}${primaryKey}`;
  });
  return `CREATE TABLE ${quoteIdentifier(declaration.projection.table)} (${columns.join(", ")})`;
}

function insertRows(
  sql: SqlClient.SqlClient,
  declaration: EntityDeclaration,
  rows: ReadonlyArray<DeclaredProjectionRow>
): Effect.Effect<unknown, unknown> {
  const columns = declaration.projection.columns.map((column) => quoteIdentifier(column.name));
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  return sql.unsafe(
    `INSERT INTO ${quoteIdentifier(declaration.projection.table)} (${columns.join(", ")}) VALUES ${rows.map(() => placeholders).join(", ")}`,
    rows.flatMap((row) => declaration.projection.columns.map((column) => row[column.name] ?? null))
  );
}

function sqliteType(type: EntityProjectionColumnDeclaration["type"]): string {
  return type === "integer" || type === "boolean" ? "INTEGER" : "TEXT";
}

function chunks<Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> {
  const output: Value[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function templateMatcher(template: string): { readonly pattern: RegExp; readonly keys: ReadonlyArray<string> } {
  const keys: string[] = [];
  let source = "";
  let cursor = 0;
  for (const match of template.matchAll(/\{([^{}]+)\}/gu)) {
    source += escapeRegExp(template.slice(cursor, match.index));
    source += "([^/]+)";
    keys.push(match[1]!);
    cursor = match.index + match[0].length;
  }
  source += escapeRegExp(template.slice(cursor));
  return { pattern: new RegExp(`^${source}$`, "u"), keys };
}

function listTemplateFiles(rootPath: string, template: string): {
  readonly files: ReadonlyArray<string>;
  readonly directories: ReadonlyArray<string>;
  readonly directorySignatures: ReadonlyMap<string, string>;
  readonly directoriesVisited: number;
  readonly entriesVisited: number;
} {
  if (!localLayoutFileSystem.exists(rootPath)) return { files: [], directories: [], directorySignatures: new Map(), directoriesVisited: 0, entriesVisited: 0 };
  const segments = template.split("/");
  const segmentMatchers = segments.map(templateSegmentMatcher);
  const files: string[] = [];
  const directories: string[] = [];
  const directorySignatures = new Map<string, string>();
  let directoriesVisited = 0;
  let entriesVisited = 0;
  function visit(directory: string, segmentIndex: number, relativeSegments: ReadonlyArray<string>): void {
    directoriesVisited += 1;
    directories.push(directory);
    const stableDirectory = localProjectionSourceFileSystem.readStableDirents(directory);
    directorySignatures.set(directory, stableDirectory.signature);
    for (const entry of stableDirectory.entries) {
      entriesVisited += 1;
      if (!segmentMatchers[segmentIndex]!.test(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const nextRelativeSegments = [...relativeSegments, entry.name];
      if (segmentIndex === segments.length - 1) {
        if (!entry.isDirectory()) files.push(nextRelativeSegments.join("/"));
      } else if (entry.isDirectory()) {
        visit(fullPath, segmentIndex + 1, nextRelativeSegments);
      }
    }
  }
  visit(rootPath, 0, []);
  return { files: files.sort(), directories, directorySignatures, directoriesVisited, entriesVisited };
}

function sourceCacheEntryMatches(
  entry: DeclaredEntitySourceCacheEntry,
  validation: "stable" | "verify" = "stable"
): boolean {
  const signatures = new Map([...entry.directorySignatures, ...entry.fileSignatures]);
  return pathSignaturesMatch(signatures) &&
    (validation === "verify" || pathSignaturesMatch(signatures));
}

function pathSignaturesMatch(signatures: ReadonlyMap<string, string>): boolean {
  for (const [inputPath, expected] of signatures) {
    if (readPathSignature(inputPath) !== expected) return false;
  }
  return true;
}

function readPathSignature(inputPath: string): string | null {
  return localProjectionSourceFileSystem.statSignature(inputPath);
}

function evictDeclaredEntitySourceCache(): void {
  while (declaredEntitySourceCache.size > declaredEntitySourceCacheLimit) {
    const oldest = declaredEntitySourceCache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    declaredEntitySourceCache.delete(oldest);
  }
}

function templateSegmentMatcher(segment: string): RegExp {
  let source = "";
  let cursor = 0;
  for (const match of segment.matchAll(/\{([^{}]+)\}/gu)) {
    source += escapeRegExp(segment.slice(cursor, match.index));
    source += "[^/]+";
    cursor = match.index + match[0].length;
  }
  source += escapeRegExp(segment.slice(cursor));
  return new RegExp(`^${source}$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
