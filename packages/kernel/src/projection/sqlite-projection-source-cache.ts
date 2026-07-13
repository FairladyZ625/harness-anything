import path from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { sha256Text, stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter } from "../markdown/frontmatter.ts";
import {
  captureAttributionEventSourcePersistentCache,
  restoreAttributionEventSourcePersistentCache,
  type AttributionEventSourcePersistentCache
} from "../local/attribution-event-source.ts";
import {
  captureMarkdownSourcePersistentCache,
  restoreMarkdownSourcePersistentCache,
  type MarkdownSourcePersistentCache,
  type TaskProjectionSourceHashInput
} from "./sqlite-task-source.ts";
import { runSqlite } from "./sqlite-projection-store.ts";

type ProjectionSourceCacheKind = "task" | "attribution";

export interface ProjectionSourceCacheFileRow {
  readonly cacheKind: ProjectionSourceCacheKind;
  readonly sourcePath: string;
  readonly sourceKind: string;
  readonly ownerId?: string;
  readonly statSignature: string;
  readonly contentSha256: string;
  readonly body: string;
}

export interface ProjectionSourceCacheWatchRow {
  readonly cacheKind: ProjectionSourceCacheKind;
  readonly sourcePath: string;
  readonly statSignature: string | null;
}

export interface ProjectionSourceCacheMetadataRow {
  readonly cacheKind: ProjectionSourceCacheKind;
  readonly payloadJson: string;
  readonly payloadSha256: string;
}

export interface ProjectionSourceCacheSnapshot {
  readonly files: ReadonlyArray<ProjectionSourceCacheFileRow>;
  readonly watches: ReadonlyArray<ProjectionSourceCacheWatchRow>;
  readonly metadata: ReadonlyArray<ProjectionSourceCacheMetadataRow>;
  readonly hash: string;
}

export interface ProjectionSourceCacheChange {
  readonly previous: ProjectionSourceCacheSnapshot;
  readonly current: ProjectionSourceCacheSnapshot;
}

interface SourceCacheFileRecord {
  readonly cache_kind: unknown;
  readonly source_path: unknown;
  readonly source_kind: unknown;
  readonly owner_id: unknown;
  readonly stat_signature: unknown;
  readonly content_sha256: unknown;
  readonly body: unknown;
}

interface SourceCacheWatchRecord {
  readonly cache_kind: unknown;
  readonly source_path: unknown;
  readonly stat_signature: unknown;
}

interface SourceCacheMetadataRecord {
  readonly cache_kind: unknown;
  readonly payload_json: unknown;
  readonly payload_sha256: unknown;
}

export function captureProjectionSourceCacheSnapshot(
  rootInput: HarnessLayoutInput
): ProjectionSourceCacheSnapshot | null {
  const task = captureMarkdownSourcePersistentCache(rootInput);
  const attribution = captureAttributionEventSourcePersistentCache(rootInput);
  if (!task || !attribution) return null;
  const layout = resolveHarnessLayout(rootInput);
  const taskEntries = new Map(task.result.entries.map((entry) => [entry.indexPath, entry]));
  const taskFiles = task.result.sourceInputs.map((input) => {
    const entry = taskEntries.get(input.sourcePath);
    return {
      cacheKind: "task" as const,
      sourcePath: input.sourcePath,
      sourceKind: input.kind,
      ...(entry ? { ownerId: entry.taskId } : {}),
      statSignature: input.statSignature,
      contentSha256: sha256Text(input.body),
      body: input.body
    };
  });
  const attributionFiles = attribution.source.inputs.map((input) => ({
    cacheKind: "attribution" as const,
    sourcePath: rootRelativePath(layout.rootDir, path.join(layout.attributionEventsRoot, input.relativePath)),
    sourceKind: "attribution-event",
    statSignature: input.statSignature,
    contentSha256: input.contentSha256,
    body: input.body
  }));
  const fileKeys = new Set([...taskFiles, ...attributionFiles].map(cachePathKey));
  const watches = [
    ...task.directorySignatures.map((entry) => ({ cacheKind: "task" as const, sourcePath: entry.relativePath, statSignature: entry.signature })),
    ...attribution.signatures
      .filter((entry) => !fileKeys.has(cachePathKey({ cacheKind: "attribution", sourcePath: entry.relativePath })))
      .map((entry) => ({ cacheKind: "attribution" as const, sourcePath: entry.relativePath, statSignature: entry.signature }))
  ];
  return projectionSourceCacheSnapshot({
    files: [...taskFiles, ...attributionFiles],
    watches,
    metadata: [
      metadataRow("task", { schema: "task-source-cache-metadata/v1", layoutIdentity: task.layoutIdentity, warnings: task.result.warnings }),
      metadataRow("attribution", { schema: "attribution-source-cache-metadata/v1", layoutIdentity: attribution.layoutIdentity })
    ]
  });
}

export function readProjectionSourceCacheSnapshot(projectionPath: string): ProjectionSourceCacheSnapshot {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`BEGIN`;
    try {
      const files = yield* sql<SourceCacheFileRecord>`
        SELECT cache_kind, source_path, source_kind, owner_id, stat_signature,
               content_sha256, body
        FROM projection_source_cache_files
        ORDER BY cache_kind, source_path
      `;
      const watches = yield* sql<SourceCacheWatchRecord>`
        SELECT cache_kind, source_path, stat_signature
        FROM projection_source_cache_watches
        ORDER BY cache_kind, source_path
      `;
      const metadata = yield* sql<SourceCacheMetadataRecord>`
        SELECT cache_kind, payload_json, payload_sha256
        FROM projection_source_cache_metadata
        ORDER BY cache_kind
      `;
      const snapshot = projectionSourceCacheSnapshot({
        files: files.map(recordToFileRow),
        watches: watches.map(recordToWatchRow),
        metadata: metadata.map(recordToMetadataRow)
      });
      yield* sql`COMMIT`;
      return snapshot;
    } catch (error) {
      yield* sql`ROLLBACK`;
      throw error;
    }
  }));
}

export function restoreProjectionSourceCacheSnapshot(
  rootInput: HarnessLayoutInput,
  snapshot: ProjectionSourceCacheSnapshot
): {
  readonly valid: boolean;
  readonly task: "fresh" | "stale";
  readonly attribution: "fresh" | "stale";
} {
  try {
    const layout = resolveHarnessLayout(rootInput);
    const metadata = new Map(snapshot.metadata.map((row) => [row.cacheKind, JSON.parse(row.payloadJson) as Record<string, unknown>]));
    const taskMetadata = requiredMetadata(metadata, "task");
    const attributionMetadata = requiredMetadata(metadata, "attribution");
    const taskLayoutIdentity = [layout.rootDir, layout.authoredRoot, layout.tasksRoot, layout.decisionsRoot].join("\0");
    if (taskMetadata.layoutIdentity !== taskLayoutIdentity ||
        attributionMetadata.layoutIdentity !== layout.attributionEventsRoot) {
      return { valid: true, task: "stale", attribution: "stale" };
    }
    const taskFiles = snapshot.files.filter((row) => row.cacheKind === "task");
    const taskInputs: TaskProjectionSourceHashInput[] = taskFiles
      .map((row) => ({ kind: row.sourceKind, sourcePath: row.sourcePath, body: row.body, statSignature: row.statSignature }))
      .sort(compareTaskSourceInputs);
    const task: MarkdownSourcePersistentCache = {
      schema: "markdown-source-cache/v1",
      layoutIdentity: String(taskMetadata.layoutIdentity),
      result: {
        entries: taskFiles.filter((row) => row.sourceKind === "task-index").map((row) => ({
          taskId: row.ownerId ?? path.basename(path.dirname(row.sourcePath)),
          indexPath: row.sourcePath,
          body: row.body,
          frontmatter: readFrontmatter(row.body) ?? "",
          statSignature: row.statSignature
        })),
        hash: taskSourceHash(taskInputs),
        warnings: Array.isArray(taskMetadata.warnings) ? taskMetadata.warnings as MarkdownSourcePersistentCache["result"]["warnings"] : [],
        sourceInputs: taskInputs
      },
      fileSignatures: taskFiles.map((row) => ({ relativePath: row.sourcePath, signature: row.statSignature })),
      directorySignatures: snapshot.watches
        .filter((row) => row.cacheKind === "task")
        .map((row) => ({ relativePath: row.sourcePath, signature: row.statSignature }))
    };
    const attributionFiles = snapshot.files.filter((row) => row.cacheKind === "attribution");
    const attribution: AttributionEventSourcePersistentCache = {
      schema: "attribution-event-source-cache/v1",
      layoutIdentity: String(attributionMetadata.layoutIdentity),
      source: {
        inputs: attributionFiles.map((row) => ({
          relativePath: path.relative(layout.attributionEventsRoot, path.resolve(layout.rootDir, row.sourcePath)).split(path.sep).join("/"),
          body: row.body,
          statSignature: row.statSignature,
          contentSha256: row.contentSha256
        })),
        hash: stablePayloadHash({
          schema: "attribution-event-source/v2",
          inputs: attributionFiles.map((row) => ({
            relativePath: path.relative(layout.attributionEventsRoot, path.resolve(layout.rootDir, row.sourcePath)).split(path.sep).join("/"),
            contentSha256: row.contentSha256
          }))
        })
      },
      signatures: [
        ...attributionFiles.map((row) => ({ relativePath: row.sourcePath, signature: row.statSignature })),
        ...snapshot.watches
          .filter((row) => row.cacheKind === "attribution")
          .map((row) => ({ relativePath: row.sourcePath, signature: row.statSignature }))
      ]
    };
    const taskRestore = restoreMarkdownSourcePersistentCache(rootInput, task);
    const attributionRestore = restoreAttributionEventSourcePersistentCache(rootInput, attribution);
    if (taskRestore === "invalid" || attributionRestore === "invalid") {
      return { valid: false, task: "stale", attribution: "stale" };
    }
    return { valid: true, task: taskRestore, attribution: attributionRestore };
  } catch {
    return { valid: false, task: "stale", attribution: "stale" };
  }
}

export function replaceProjectionSourceCacheRows(
  sql: SqlClient.SqlClient,
  snapshot: ProjectionSourceCacheSnapshot
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* createProjectionSourceCacheTables(sql);
    yield* sql`DELETE FROM projection_source_cache_files`;
    yield* sql`DELETE FROM projection_source_cache_watches`;
    yield* sql`DELETE FROM projection_source_cache_metadata`;
    for (const rows of chunks(snapshot.files, 250)) yield* insertFileRows(sql, rows);
    for (const rows of chunks(snapshot.watches, 500)) yield* insertWatchRows(sql, rows);
    for (const row of snapshot.metadata) yield* upsertMetadataRow(sql, row);
  });
}

export function applyProjectionSourceCacheChange(
  sql: SqlClient.SqlClient,
  change: ProjectionSourceCacheChange
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* createProjectionSourceCacheTables(sql);
    const currentFiles = new Map(change.current.files.map((row) => [cachePathKey(row), row]));
    const previousFiles = new Map(change.previous.files.map((row) => [cachePathKey(row), row]));
    for (const [key, row] of previousFiles) {
      if (!currentFiles.has(key)) yield* deleteCachePath(sql, "projection_source_cache_files", row);
    }
    for (const [key, row] of currentFiles) {
      if (!sameFileRow(previousFiles.get(key), row)) yield* upsertFileRow(sql, row);
    }
    const currentWatches = new Map(change.current.watches.map((row) => [cachePathKey(row), row]));
    const previousWatches = new Map(change.previous.watches.map((row) => [cachePathKey(row), row]));
    for (const [key, row] of previousWatches) {
      if (!currentWatches.has(key)) yield* deleteCachePath(sql, "projection_source_cache_watches", row);
    }
    for (const [key, row] of currentWatches) {
      if (!sameWatchRow(previousWatches.get(key), row)) yield* upsertWatchRow(sql, row);
    }
    const previousMetadata = new Map(change.previous.metadata.map((row) => [row.cacheKind, row]));
    for (const row of change.current.metadata) {
      if (previousMetadata.get(row.cacheKind)?.payloadSha256 !== row.payloadSha256) yield* upsertMetadataRow(sql, row);
    }
  });
}

export function updateProjectionSourceCacheSnapshot(
  projectionPath: string,
  previous: ProjectionSourceCacheSnapshot,
  current: ProjectionSourceCacheSnapshot
): void {
  runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`BEGIN IMMEDIATE`;
    try {
      yield* applyProjectionSourceCacheChange(sql, { previous, current });
      yield* sql`
        INSERT OR REPLACE INTO projection_meta (key, value)
        VALUES ('sourceCacheHash', ${current.hash})
      `;
      yield* sql`COMMIT`;
    } catch (error) {
      yield* sql`ROLLBACK`;
      throw error;
    }
  }));
}

function projectionSourceCacheSnapshot(input: {
  readonly files: ReadonlyArray<ProjectionSourceCacheFileRow>;
  readonly watches: ReadonlyArray<ProjectionSourceCacheWatchRow>;
  readonly metadata: ReadonlyArray<ProjectionSourceCacheMetadataRow>;
}): ProjectionSourceCacheSnapshot {
  const files = [...input.files].sort(compareCachePaths);
  const watches = [...input.watches].sort(compareCachePaths);
  const metadata = [...input.metadata].sort((left, right) => left.cacheKind.localeCompare(right.cacheKind));
  assertCacheKinds(metadata.map((row) => row.cacheKind));
  for (const row of files) {
    if (sha256Text(row.body) !== row.contentSha256) throw new Error(`projection source cache body hash mismatch: ${row.sourcePath}`);
  }
  for (const row of metadata) {
    const expected = stablePayloadHash({ schema: "projection-source-cache-metadata-payload/v1", payloadJson: row.payloadJson });
    if (row.payloadSha256 !== expected) throw new Error(`projection source cache metadata hash mismatch: ${row.cacheKind}`);
  }
  return {
    files,
    watches,
    metadata,
    hash: stablePayloadHash({
      schema: "projection-source-cache/v2",
      files: files.map(({ body: _body, ...row }) => row),
      watches,
      metadata: metadata.map(({ cacheKind, payloadSha256 }) => ({ cacheKind, payloadSha256 }))
    })
  };
}

function metadataRow(cacheKind: ProjectionSourceCacheKind, payload: unknown): ProjectionSourceCacheMetadataRow {
  const payloadJson = JSON.stringify(payload);
  return {
    cacheKind,
    payloadJson,
    payloadSha256: stablePayloadHash({ schema: "projection-source-cache-metadata-payload/v1", payloadJson })
  };
}

function createProjectionSourceCacheTables(sql: SqlClient.SqlClient): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_source_cache_files (
        cache_kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        owner_id TEXT,
        stat_signature TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (cache_kind, source_path)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_source_cache_watches (
        cache_kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        stat_signature TEXT,
        PRIMARY KEY (cache_kind, source_path)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_source_cache_metadata (
        cache_kind TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL
      )
    `;
  });
}

function upsertFileRow(sql: SqlClient.SqlClient, row: ProjectionSourceCacheFileRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO projection_source_cache_files (
      cache_kind, source_path, source_kind, owner_id, stat_signature,
      content_sha256, body
    ) VALUES (
      ${row.cacheKind}, ${row.sourcePath}, ${row.sourceKind}, ${row.ownerId ?? null},
      ${row.statSignature}, ${row.contentSha256}, ${row.body}
    )
  `;
}

function insertFileRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<ProjectionSourceCacheFileRow>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO projection_source_cache_files (
      cache_kind, source_path, source_kind, owner_id, stat_signature,
      content_sha256, body
    ) VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
  `, rows.flatMap((row) => [
    row.cacheKind,
    row.sourcePath,
    row.sourceKind,
    row.ownerId ?? null,
    row.statSignature,
    row.contentSha256,
    row.body
  ]));
}

function upsertWatchRow(sql: SqlClient.SqlClient, row: ProjectionSourceCacheWatchRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO projection_source_cache_watches (cache_kind, source_path, stat_signature)
    VALUES (${row.cacheKind}, ${row.sourcePath}, ${row.statSignature})
  `;
}

function insertWatchRows(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<ProjectionSourceCacheWatchRow>
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`
    INSERT INTO projection_source_cache_watches (cache_kind, source_path, stat_signature)
    VALUES ${rows.map(() => "(?, ?, ?)").join(", ")}
  `, rows.flatMap((row) => [row.cacheKind, row.sourcePath, row.statSignature]));
}

function upsertMetadataRow(sql: SqlClient.SqlClient, row: ProjectionSourceCacheMetadataRow): Effect.Effect<unknown, unknown> {
  return sql`
    INSERT OR REPLACE INTO projection_source_cache_metadata (cache_kind, payload_json, payload_sha256)
    VALUES (${row.cacheKind}, ${row.payloadJson}, ${row.payloadSha256})
  `;
}

function deleteCachePath(
  sql: SqlClient.SqlClient,
  table: "projection_source_cache_files" | "projection_source_cache_watches",
  row: { readonly cacheKind: string; readonly sourcePath: string }
): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`DELETE FROM ${table} WHERE cache_kind = ? AND source_path = ?`, [row.cacheKind, row.sourcePath]);
}

function recordToFileRow(record: SourceCacheFileRecord): ProjectionSourceCacheFileRow {
  return {
    cacheKind: cacheKind(record.cache_kind),
    sourcePath: String(record.source_path),
    sourceKind: String(record.source_kind),
    ...(record.owner_id === null ? {} : { ownerId: String(record.owner_id) }),
    statSignature: String(record.stat_signature),
    contentSha256: String(record.content_sha256),
    body: String(record.body)
  };
}

function recordToWatchRow(record: SourceCacheWatchRecord): ProjectionSourceCacheWatchRow {
  return {
    cacheKind: cacheKind(record.cache_kind),
    sourcePath: String(record.source_path),
    statSignature: record.stat_signature === null ? null : String(record.stat_signature)
  };
}

function recordToMetadataRow(record: SourceCacheMetadataRecord): ProjectionSourceCacheMetadataRow {
  return {
    cacheKind: cacheKind(record.cache_kind),
    payloadJson: String(record.payload_json),
    payloadSha256: String(record.payload_sha256)
  };
}

function cacheKind(value: unknown): ProjectionSourceCacheKind {
  const kind = String(value);
  if (kind !== "task" && kind !== "attribution") throw new Error(`unknown projection source cache kind: ${kind}`);
  return kind;
}

function requiredMetadata(
  rows: ReadonlyMap<ProjectionSourceCacheKind, Record<string, unknown>>,
  kind: ProjectionSourceCacheKind
): Record<string, unknown> {
  const row = rows.get(kind);
  if (!row) throw new Error(`projection source cache metadata missing: ${kind}`);
  return row;
}

function assertCacheKinds(kinds: ReadonlyArray<ProjectionSourceCacheKind>): void {
  if (kinds.length !== 2 || new Set(kinds).size !== 2 || !kinds.includes("task") || !kinds.includes("attribution")) {
    throw new Error("projection source cache metadata must contain task and attribution rows");
  }
}

function rootRelativePath(rootDir: string, inputPath: string): string {
  return path.relative(rootDir, inputPath).split(path.sep).join("/");
}

function cachePathKey(row: { readonly cacheKind: string; readonly sourcePath: string }): string {
  return `${row.cacheKind}\0${row.sourcePath}`;
}

function compareCachePaths(
  left: { readonly cacheKind: string; readonly sourcePath: string },
  right: { readonly cacheKind: string; readonly sourcePath: string }
): number {
  return cachePathKey(left).localeCompare(cachePathKey(right));
}

function compareTaskSourceInputs(left: TaskProjectionSourceHashInput, right: TaskProjectionSourceHashInput): number {
  const leftRank = left.kind === "task-index" ? 0 : 1;
  const rightRank = right.kind === "task-index" ? 0 : 1;
  return leftRank - rightRank || left.sourcePath.localeCompare(right.sourcePath);
}

function taskSourceHash(inputs: ReadonlyArray<TaskProjectionSourceHashInput>): string {
  return `sha256:${sha256Text(JSON.stringify(inputs.map(({ kind, sourcePath, body }) => ({ kind, sourcePath, body }))))}`;
}

function sameFileRow(left: ProjectionSourceCacheFileRow | undefined, right: ProjectionSourceCacheFileRow): boolean {
  return left !== undefined && stablePayloadHash({ ...left, body: undefined }) === stablePayloadHash({ ...right, body: undefined });
}

function sameWatchRow(left: ProjectionSourceCacheWatchRow | undefined, right: ProjectionSourceCacheWatchRow): boolean {
  return left !== undefined && left.statSignature === right.statSignature;
}

function chunks<Value>(values: ReadonlyArray<Value>, size: number): ReadonlyArray<ReadonlyArray<Value>> {
  const output: Value[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}
