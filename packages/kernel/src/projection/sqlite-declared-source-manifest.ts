import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { EntityDeclaration } from "../entity/declaration.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import {
  projectDeclaredEntitySource,
  type DeclaredEntityDocumentProjection,
  type DeclaredProjectionRow
} from "./entity-declaration-projection.ts";
import type { DeclaredEntitySourceSnapshot, DeclaredProjectionSnapshot } from "./projection-source-snapshot.ts";
import { runSqliteReadonly } from "./sqlite-projection-store.ts";

export interface DeclaredSourceManifestRow {
  readonly sourcePath: string;
  readonly sourceKind: string;
  readonly projectionTable: string;
  readonly primaryKey: string;
  readonly statSignature: string;
  readonly contentSha256: string;
  readonly projectedRowSha256: string;
}

export interface DeclaredTableProjectionDelta {
  readonly declaration: EntityDeclaration;
  readonly deletePrimaryKeys: ReadonlyArray<string>;
  readonly upsertRows: ReadonlyArray<DeclaredProjectionRow>;
}

export interface DeclaredProjectionDelta {
  readonly tables: ReadonlyArray<DeclaredTableProjectionDelta>;
  readonly manifest: {
    readonly deleteSourcePaths: ReadonlyArray<string>;
    readonly upsertRows: ReadonlyArray<DeclaredSourceManifestRow>;
    readonly currentRows: ReadonlyArray<DeclaredSourceManifestRow>;
  };
}

interface DeclaredSourceManifestRecord {
  readonly source_path: unknown;
  readonly source_kind: unknown;
  readonly projection_table: unknown;
  readonly primary_key: unknown;
  readonly stat_signature: unknown;
  readonly content_sha256: unknown;
  readonly projected_row_sha256: unknown;
}

export function declaredSourceManifestRows(
  tables: ReadonlyArray<DeclaredProjectionSnapshot>,
  sources: ReadonlyArray<DeclaredEntitySourceSnapshot> = []
): ReadonlyArray<DeclaredSourceManifestRow> {
  const documentsByPath = new Map(tables.flatMap((table) =>
    table.documents.map((document) => [document.relativePath, { table, document }] as const)));
  const rows = sources.length === 0
    ? [...documentsByPath.values()].map(({ table, document }) => manifestRowForDocument(table, document))
    : sources.flatMap((source) => source.source.inputs.map((input) => {
      const projected = documentsByPath.get(input.relativePath);
      return projected
        ? manifestRowForDocument(projected.table, projected.document)
        : {
            sourcePath: input.relativePath,
            sourceKind: source.declaration.kind,
            projectionTable: source.table,
            primaryKey: "",
            statSignature: input.statSignature,
            contentSha256: input.contentSha256,
            projectedRowSha256: stablePayloadHash({ ignored: true })
          };
    }));
  assertUniqueProjectedIdentities(rows);
  return rows.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

export function hashDeclaredSourceManifestRows(rows: ReadonlyArray<DeclaredSourceManifestRow>): string {
  return stablePayloadHash({
    schema: "declared-source-manifest/v1",
    rows: [...rows].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  });
}

export function hashDeclaredProjectionIntegrityRows(rows: ReadonlyArray<DeclaredSourceManifestRow>): string {
  return stablePayloadHash({
    schema: "declared-projection-integrity/v1",
    rows: rows
      .filter((row) => row.primaryKey.length > 0)
      .map(({ projectionTable, primaryKey, projectedRowSha256 }) => ({
        projectionTable,
        primaryKey,
        projectedRowSha256
      }))
      .sort((left, right) => left.projectionTable.localeCompare(right.projectionTable)
        || left.primaryKey.localeCompare(right.primaryKey))
  });
}

export function declaredProjectionRowsMatchManifest(
  tables: ReadonlyArray<DeclaredProjectionSnapshot>,
  manifest: ReadonlyArray<DeclaredSourceManifestRow>
): boolean {
  const actual = new Map(tables.flatMap((table) => {
    const primaryKey = table.declaration.projection.columns.find((column) => column.primaryKey)!;
    return table.rows.map((row) => [
      `${table.table}\0${String(row[primaryKey.name])}`,
      stablePayloadHash(row)
    ] as const);
  }));
  const expected = manifest.filter((row) => row.primaryKey.length > 0);
  if (actual.size !== expected.length) return false;
  return expected.every((row) =>
    actual.get(`${row.projectionTable}\0${row.primaryKey}`) === row.projectedRowSha256);
}

export function buildDeclaredProjectionDelta(
  previousRows: ReadonlyArray<DeclaredSourceManifestRow>,
  currentTables: ReadonlyArray<DeclaredProjectionSnapshot>
): DeclaredProjectionDelta {
  const currentManifest = declaredSourceManifestRows(currentTables);
  const currentDocuments = new Map(currentTables.flatMap((table) =>
    table.documents.map((document) => [document.relativePath, { declaration: table.declaration, document }] as const)));
  return buildDeltaFromManifest(
    previousRows,
    currentManifest,
    currentDocuments,
    currentTables.map(({ declaration, table }) => ({ declaration, table }))
  );
}

function buildDeltaFromManifest(
  previousRows: ReadonlyArray<DeclaredSourceManifestRow>,
  currentManifest: ReadonlyArray<DeclaredSourceManifestRow>,
  currentDocuments: ReadonlyMap<string, {
    readonly declaration: EntityDeclaration;
    readonly document: DeclaredEntityDocumentProjection;
  }>,
  declarations: ReadonlyArray<{ readonly declaration: EntityDeclaration; readonly table: string }>
): DeclaredProjectionDelta {
  assertUniqueProjectedIdentities(currentManifest);
  const previousByPath = new Map(previousRows.map((row) => [row.sourcePath, row]));
  const currentByPath = new Map(currentManifest.map((row) => [row.sourcePath, row]));
  const tableChanges = new Map<string, {
    readonly declaration: EntityDeclaration;
    readonly deletePrimaryKeys: Set<string>;
    readonly upsertRows: DeclaredProjectionRow[];
  }>();
  const tableChange = (declaration: EntityDeclaration) => {
    const existing = tableChanges.get(declaration.projection.table);
    if (existing) return existing;
    const created = { declaration, deletePrimaryKeys: new Set<string>(), upsertRows: [] as DeclaredProjectionRow[] };
    tableChanges.set(declaration.projection.table, created);
    return created;
  };
  const manifestUpserts: DeclaredSourceManifestRow[] = [];
  for (const current of currentManifest) {
    const previous = previousByPath.get(current.sourcePath);
    if (previous?.statSignature !== current.statSignature) manifestUpserts.push(current);
    if (previous?.contentSha256 === current.contentSha256 && previous.projectedRowSha256 === current.projectedRowSha256) continue;
    const projected = currentDocuments.get(current.sourcePath);
    if (current.primaryKey === "") {
      if (previous?.primaryKey) tableChange(declarations.find((item) => item.table === previous.projectionTable)!.declaration)
        .deletePrimaryKeys.add(previous.primaryKey);
      continue;
    }
    if (!projected) throw new Error(`changed declared source was not decoded: ${current.sourcePath}`);
    const change = tableChange(projected.declaration);
    if (previous?.primaryKey && previous.primaryKey !== current.primaryKey) change.deletePrimaryKeys.add(previous.primaryKey);
    change.upsertRows.push(projected.document.row);
  }
  const deletedSourcePaths: string[] = [];
  for (const previous of previousRows) {
    if (currentByPath.has(previous.sourcePath)) continue;
    deletedSourcePaths.push(previous.sourcePath);
    const declaration = declarations.find((item) => item.table === previous.projectionTable)?.declaration;
    if (declaration && previous.primaryKey) tableChange(declaration).deletePrimaryKeys.add(previous.primaryKey);
  }
  return {
    tables: [...tableChanges.values()].map((change) => ({
      declaration: change.declaration,
      deletePrimaryKeys: [...change.deletePrimaryKeys],
      upsertRows: change.upsertRows
    })),
    manifest: {
      deleteSourcePaths: deletedSourcePaths,
      upsertRows: manifestUpserts,
      currentRows: currentManifest
    }
  };
}

export function buildDeclaredProjectionDeltaFromSources(
  rootInput: HarnessLayoutInput,
  previousRows: ReadonlyArray<DeclaredSourceManifestRow>,
  currentSources: ReadonlyArray<DeclaredEntitySourceSnapshot>
): DeclaredProjectionDelta {
  const previousByPath = new Map(previousRows.map((row) => [row.sourcePath, row]));
  const documentsByPath = new Map<string, {
    readonly declaration: EntityDeclaration;
    readonly document: DeclaredEntityDocumentProjection;
  }>();
  const currentManifest: DeclaredSourceManifestRow[] = [];
  for (const current of currentSources) {
    for (const input of current.source.inputs) {
      const previous = previousByPath.get(input.relativePath);
      if (input.body === undefined) {
        if (!previous) throw new Error(`declared source manifest row missing for ${input.relativePath}`);
        currentManifest.push(previous);
        continue;
      }
      if (previous?.contentSha256 === input.contentSha256) {
        currentManifest.push({ ...previous, statSignature: input.statSignature });
        continue;
      }
      const projected = projectDeclaredEntitySource(rootInput, current.declaration, {
        inputs: [input],
        hash: current.source.hash,
        stats: current.source.stats
      });
      const document = projected.documents[0];
      if (!document) {
        currentManifest.push({
          sourcePath: input.relativePath,
          sourceKind: current.declaration.kind,
          projectionTable: current.table,
          primaryKey: "",
          statSignature: input.statSignature,
          contentSha256: input.contentSha256,
          projectedRowSha256: stablePayloadHash({ ignored: true })
        });
        continue;
      }
      documentsByPath.set(input.relativePath, { declaration: current.declaration, document });
      currentManifest.push({
        sourcePath: input.relativePath,
        sourceKind: current.declaration.kind,
        projectionTable: current.table,
        primaryKey: document.primaryKey,
        statSignature: input.statSignature,
        contentSha256: input.contentSha256,
        projectedRowSha256: stablePayloadHash(document.row)
      });
    }
  }
  return buildDeltaFromManifest(previousRows, currentManifest, documentsByPath, currentSources.map(({ declaration, table }) => ({ declaration, table })));
}

export function applyDeclaredProjectionDeltaToSnapshots(
  snapshots: ReadonlyArray<DeclaredProjectionSnapshot>,
  delta: DeclaredProjectionDelta
): ReadonlyArray<DeclaredProjectionSnapshot> {
  const changes = new Map(delta.tables.map((table) => [table.declaration.projection.table, table]));
  return snapshots.map((snapshot) => {
    const change = changes.get(snapshot.table);
    if (!change) return snapshot;
    const primaryKey = snapshot.declaration.projection.columns.find((column) => column.primaryKey)!;
    const replaced = new Set([
      ...change.deletePrimaryKeys,
      ...change.upsertRows.map((row) => String(row[primaryKey.name]))
    ]);
    return {
      ...snapshot,
      rows: [
        ...snapshot.rows.filter((row) => !replaced.has(String(row[primaryKey.name]))),
        ...change.upsertRows
      ].sort((left, right) => String(left[primaryKey.name]).localeCompare(String(right[primaryKey.name])))
    };
  });
}

export function replaceDeclaredSourceManifestRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<DeclaredSourceManifestRow>
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* createDeclaredSourceManifestTable(sql);
    yield* sql`DELETE FROM declared_source_manifest`;
    for (const batch of chunks(rows, 500)) yield* insertDeclaredSourceManifestRows(sql, batch);
  });
}

export function readDeclaredSourceManifestRows(projectionPath: string): ReadonlyArray<DeclaredSourceManifestRow> {
  return runSqliteReadonly(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql<DeclaredSourceManifestRecord>`
      SELECT source_path, source_kind, projection_table, primary_key,
             stat_signature, content_sha256, projected_row_sha256
      FROM declared_source_manifest
      ORDER BY source_path
    `;
    return records.map(recordToManifestRow);
  }));
}

export function applyDeclaredSourceManifestDelta(
  sql: SqlClient.SqlClient,
  change: {
    readonly deleteSourcePaths: ReadonlyArray<string>;
    readonly upsertRows: ReadonlyArray<DeclaredSourceManifestRow>;
  }
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    for (const sourcePath of [...new Set(change.deleteSourcePaths)]) {
      yield* sql`DELETE FROM declared_source_manifest WHERE source_path = ${sourcePath}`;
    }
    for (const row of change.upsertRows) yield* upsertDeclaredSourceManifestRow(sql, row);
  });
}

function createDeclaredSourceManifestTable(sql: SqlClient.SqlClient): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    yield* sql`
      CREATE TABLE declared_source_manifest (
        source_path TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        projection_table TEXT NOT NULL,
        primary_key TEXT NOT NULL,
        stat_signature TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        projected_row_sha256 TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE UNIQUE INDEX declared_source_manifest_identity
      ON declared_source_manifest (projection_table, primary_key)
      WHERE primary_key <> ''
    `;
  });
}

function manifestRowForDocument(
  table: DeclaredProjectionSnapshot,
  document: DeclaredEntityDocumentProjection
): DeclaredSourceManifestRow {
  return {
    sourcePath: document.relativePath,
    sourceKind: table.declaration.kind,
    projectionTable: table.table,
    primaryKey: document.primaryKey,
    statSignature: document.statSignature,
    contentSha256: document.sourceHash,
    projectedRowSha256: stablePayloadHash(document.row)
  };
}

function assertUniqueProjectedIdentities(rows: ReadonlyArray<DeclaredSourceManifestRow>): void {
  const owners = new Map<string, string>();
  for (const row of rows) {
    if (!row.primaryKey) continue;
    const identity = `${row.projectionTable}\0${row.primaryKey}`;
    const previous = owners.get(identity);
    if (previous && previous !== row.sourcePath) {
      throw new Error(`declared entity identity ${row.projectionTable}/${row.primaryKey} is owned by both ${previous} and ${row.sourcePath}`);
    }
    owners.set(identity, row.sourcePath);
  }
}

function upsertDeclaredSourceManifestRow(
  sql: SqlClient.SqlClient,
  row: DeclaredSourceManifestRow
): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO declared_source_manifest (
      source_path, source_kind, projection_table, primary_key,
      stat_signature, content_sha256, projected_row_sha256
    ) VALUES (
      ${row.sourcePath}, ${row.sourceKind}, ${row.projectionTable}, ${row.primaryKey},
      ${row.statSignature}, ${row.contentSha256}, ${row.projectedRowSha256}
    )
  `;
}

function insertDeclaredSourceManifestRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<DeclaredSourceManifestRow>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO declared_source_manifest (
      source_path, source_kind, projection_table, primary_key,
      stat_signature, content_sha256, projected_row_sha256
    ) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, rows.flatMap((row) => [
    row.sourcePath,
    row.sourceKind,
    row.projectionTable,
    row.primaryKey,
    row.statSignature,
    row.contentSha256,
    row.projectedRowSha256
  ]));
}

function recordToManifestRow(record: DeclaredSourceManifestRecord): DeclaredSourceManifestRow {
  return {
    sourcePath: String(record.source_path),
    sourceKind: String(record.source_kind),
    projectionTable: String(record.projection_table),
    primaryKey: String(record.primary_key),
    statSignature: String(record.stat_signature),
    contentSha256: String(record.content_sha256),
    projectedRowSha256: String(record.projected_row_sha256)
  };
}

function chunks<Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> {
  const output: Value[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}
