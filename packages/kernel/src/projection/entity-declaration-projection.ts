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
import { localLayoutFileSystem, localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { quoteIdentifier, runSqlite } from "./sqlite-projection-store.ts";

export type DeclaredProjectionValue = string | number | null;
export type DeclaredProjectionRow = Readonly<Record<string, DeclaredProjectionValue>>;

export interface DeclaredProjectionResult {
  readonly table: string;
  readonly rows: ReadonlyArray<DeclaredProjectionRow>;
}

export function projectDeclaredEntities(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration,
  projectionPath: string
): DeclaredProjectionResult {
  const rows = discoverDeclaredEntityRows(rootInput, declaration);
  localRuntimeStateFileSystem.mkdirp(path.dirname(projectionPath));
  runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(declaration.projection.table)}`);
    yield* sql.unsafe(createTableSql(declaration));
    for (const row of rows) yield* insertRow(sql, declaration, row);
  }));
  return { table: declaration.projection.table, rows };
}

export function readDeclaredProjectionRows(
  projectionPath: string,
  declaration: EntityDeclaration
): ReadonlyArray<DeclaredProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = declaration.projection.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const primaryKey = declaration.projection.columns.find((column) => column.primaryKey)!;
    return yield* sql.unsafe<DeclaredProjectionRow>(
      `SELECT ${columns} FROM ${quoteIdentifier(declaration.projection.table)} ORDER BY ${quoteIdentifier(primaryKey.name)}`
    );
  }));
}

function discoverDeclaredEntityRows(
  rootInput: HarnessLayoutInput,
  declaration: EntityDeclaration
): ReadonlyArray<DeclaredProjectionRow> {
  const layout = resolveHarnessLayout(rootInput);
  const matcher = templateMatcher(declaration.rootResolver.pathTemplate);
  const rows: DeclaredProjectionRow[] = [];
  for (const relativePath of listFiles(layout.authoredRoot)) {
    const match = matcher.pattern.exec(relativePath);
    if (!match) continue;
    const identity = Object.fromEntries(matcher.keys.map((key, index) => [key, match[index + 1]!]));
    resolveEntityDocumentPath(rootInput, declaration, identity);
    const documentPath = path.join(layout.authoredRoot, relativePath);
    const raw = declaration.documentCodec.decode(localLayoutFileSystem.readText(documentPath));
    if (raw === undefined) continue;
    const decoded = Schema.decodeUnknownSync(declaration.schema)(raw) as Readonly<Record<string, unknown>>;
    rows.push(projectRow(decoded, declaration.projection.columns));
  }
  const primaryKey = declaration.projection.columns.find((column) => column.primaryKey)!;
  return rows.sort((left, right) => String(left[primaryKey.name]).localeCompare(String(right[primaryKey.name])));
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

function insertRow(
  sql: SqlClient.SqlClient,
  declaration: EntityDeclaration,
  row: DeclaredProjectionRow
): Effect.Effect<unknown, unknown> {
  const columns = declaration.projection.columns.map((column) => quoteIdentifier(column.name));
  const placeholders = columns.map(() => "?").join(", ");
  const values = declaration.projection.columns.map((column) => row[column.name] ?? null);
  return sql.unsafe(
    `INSERT INTO ${quoteIdentifier(declaration.projection.table)} (${columns.join(", ")}) VALUES (${placeholders})`,
    values
  );
}

function sqliteType(type: EntityProjectionColumnDeclaration["type"]): string {
  return type === "integer" || type === "boolean" ? "INTEGER" : "TEXT";
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

function listFiles(rootPath: string): ReadonlyArray<string> {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of localLayoutFileSystem.readDirents(directory)) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else files.push(path.relative(rootPath, fullPath).split(path.sep).join("/"));
    }
  }
  visit(rootPath);
  return files.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
