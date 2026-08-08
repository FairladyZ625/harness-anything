import path from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { sha256Text, stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import {
  captureAttributionEventSourcePersistentCache,
  decodeUnionAttributionEventBody
} from "../local/attribution-event-source.ts";
import {
  captureMarkdownSourcePersistentCache,
  readMarkdownSource
} from "./sqlite-task-source.ts";
import { projectionDatabaseFileSignature } from "./sqlite-projection-database-signature.ts";
import { runSqlite, runSqliteReadonly } from "./sqlite-projection-store.ts";
import {
  applyProjectionSourceCacheStoredChange,
  readProjectionSourceCacheRows,
  readProjectionSourceCacheStoredBody,
  replaceProjectionSourceCacheStoredRows
} from "./sqlite-projection-source-cache-store.ts";

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
  readonly kindHashes: Readonly<Record<ProjectionSourceCacheKind, string>>;
  readonly hash: string;
}

export interface ProjectionSourceCacheChange {
  readonly previous: ProjectionSourceCacheSnapshot;
  readonly current: ProjectionSourceCacheSnapshot;
  readonly deleteFiles: ReadonlyArray<ProjectionSourceCacheFileRow>;
  readonly upsertFiles: ReadonlyArray<ProjectionSourceCacheFileRow>;
  readonly deleteWatches: ReadonlyArray<ProjectionSourceCacheWatchRow>;
  readonly upsertWatches: ReadonlyArray<ProjectionSourceCacheWatchRow>;
  readonly upsertMetadata: ReadonlyArray<ProjectionSourceCacheMetadataRow>;
}

export function captureProjectionSourceCacheSnapshot(
  rootInput: HarnessLayoutInput,
  reuseValidatedCaches = false,
  previousSnapshot?: ProjectionSourceCacheSnapshot,
  refreshKinds: Readonly<{ task: boolean; attribution: boolean }> = { task: true, attribution: true }
): ProjectionSourceCacheSnapshot | null {
  const task = refreshKinds.task ? captureMarkdownSourcePersistentCache(rootInput, reuseValidatedCaches) : null;
  const attribution = refreshKinds.attribution ? captureAttributionEventSourcePersistentCache(rootInput, reuseValidatedCaches) : null;
  if ((refreshKinds.task && !task) || (refreshKinds.attribution && !attribution) ||
      (!refreshKinds.task && !previousSnapshot) || (!refreshKinds.attribution && !previousSnapshot)) return null;
  const layout = resolveHarnessLayout(rootInput);
  const taskEntries = new Map(task?.result.entries.map((entry) => [
    path.isAbsolute(entry.indexPath)
      ? rootRelativePath(layout.rootDir, entry.indexPath)
      : entry.indexPath.split(path.sep).join("/"),
    entry
  ]) ?? []);
  const previousTaskFiles = new Map(previousSnapshot?.files
    .filter((row) => row.cacheKind === "task")
    .map((row) => [row.sourcePath, row]) ?? []);
  const taskFiles = task ? task.result.sourceInputs.map((input) => {
    const entry = taskEntries.get(input.sourcePath);
    const previous = previousTaskFiles.get(input.sourcePath);
    if (previous && previous.sourceKind === input.kind && previous.statSignature === input.statSignature &&
        previous.ownerId === entry?.taskId) return previous;
    return {
      cacheKind: "task" as const,
      sourcePath: input.sourcePath,
      sourceKind: input.kind,
      ...(entry ? { ownerId: entry.taskId } : {}),
      statSignature: input.statSignature,
      contentSha256: input.contentSha256 ?? sha256Text(input.body),
      body: input.body
    };
  }) : previousSnapshot!.files.filter((row) => row.cacheKind === "task");
  const attributionFiles = attribution ? attribution.source.inputs.map((input) => ({
    cacheKind: "attribution" as const,
    sourcePath: input.sourcePath,
    sourceKind: "attribution-event",
    ownerId: input.eventId ?? decodeUnionAttributionEventBody(input.body).eventId,
    statSignature: input.statSignature,
    contentSha256: input.contentSha256,
    body: input.body
  })) : previousSnapshot!.files.filter((row) => row.cacheKind === "attribution");
  const attributionFileKeys = attribution ? new Set(attributionFiles.map(cachePathKey)) : null;
  const taskWatches = task
    ? task.directorySignatures.map((entry) => ({ cacheKind: "task" as const, sourcePath: entry.relativePath, statSignature: entry.signature }))
    : previousSnapshot!.watches.filter((row) => row.cacheKind === "task");
  const attributionWatches = attribution
      ? attribution.signatures
        .filter((entry) => !attributionFileKeys!.has(cachePathKey({ cacheKind: "attribution", sourcePath: entry.relativePath })))
        .map((entry) => ({ cacheKind: "attribution" as const, sourcePath: entry.relativePath, statSignature: entry.signature }))
      : previousSnapshot!.watches.filter((row) => row.cacheKind === "attribution");
  const previousMetadata = new Map(previousSnapshot?.metadata.map((row) => [row.cacheKind, row]) ?? []);
  return projectionSourceCacheSnapshot({
    files: [
      ...attributionFiles.sort(compareCachePaths),
      ...taskFiles.sort(compareCachePaths)
    ],
    watches: [
      ...attributionWatches.sort(compareCachePaths),
      ...taskWatches.sort(compareCachePaths)
    ],
    metadata: [
      task
        ? metadataRow("task", { schema: "task-source-cache-metadata/v1", layoutIdentity: task.layoutIdentity, warnings: task.result.warnings })
        : previousMetadata.get("task")!,
      attribution
        ? metadataRow("attribution", { schema: "attribution-source-cache-metadata/v1", layoutIdentity: attribution.layoutIdentity })
        : previousMetadata.get("attribution")!
    ]
  }, !reuseValidatedCaches, previousSnapshot ? {
    ...(!task ? { task: previousSnapshot.kindHashes.task } : {}),
    ...(!attribution ? { attribution: previousSnapshot.kindHashes.attribution } : {})
  } : {}, true);
}

export function refreshProjectionSourceCacheSnapshotForTouchedTaskPaths(
  rootInput: HarnessLayoutInput,
  previousSnapshot: ProjectionSourceCacheSnapshot,
  taskSource: ReturnType<typeof readMarkdownSource>,
  touchedPaths: ReadonlyArray<string>
): ProjectionSourceCacheSnapshot | null {
  if (touchedPaths.length === 0) return null;
  const layout = resolveHarnessLayout(rootInput);
  const currentInputs = new Map(taskSource.sourceInputs.map((input) => [input.sourcePath, input]));
  const taskOwners = new Map(taskSource.entries.map((entry) => [
    rootRelativePath(layout.rootDir, entry.indexPath),
    entry.taskId
  ]));
  const fileIndexes = new Map(previousSnapshot.files.map((row, index) => [cachePathKey(row), index]));
  const files = [...previousSnapshot.files];
  for (const touchedPath of touchedPaths) {
    const sourcePathValue = rootRelativePath(layout.rootDir, touchedPath);
    const input = currentInputs.get(sourcePathValue);
    const index = fileIndexes.get(cachePathKey({ cacheKind: "task", sourcePath: sourcePathValue }));
    if (!input || index === undefined) return null;
    const row: ProjectionSourceCacheFileRow = {
      cacheKind: "task",
      sourcePath: sourcePathValue,
      sourceKind: input.kind,
      ...(taskOwners.has(sourcePathValue) ? { ownerId: taskOwners.get(sourcePathValue) } : {}),
      statSignature: input.statSignature,
      contentSha256: input.contentSha256 ?? sha256Text(input.body),
      body: input.body
    };
    if (!validSourceCacheBody(row)) return null;
    files[index] = row;
  }
  const taskMetadata = metadataRow("task", {
    schema: "task-source-cache-metadata/v1",
    layoutIdentity: [layout.rootDir, layout.authoredRoot, layout.tasksRoot, layout.decisionsRoot].join("\0"),
    warnings: taskSource.warnings
  });
  const metadata = previousSnapshot.metadata.map((row) => row.cacheKind === "task" ? taskMetadata : row);
  return projectionSourceCacheSnapshot({
    files,
    watches: previousSnapshot.watches,
    metadata
  }, false, { attribution: previousSnapshot.kindHashes.attribution }, true);
}

export function refreshProjectionSourceCacheAfterIncrementalChange(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly previousSnapshot: ProjectionSourceCacheSnapshot | undefined;
  readonly taskSource: ReturnType<typeof readMarkdownSource>;
  readonly touchedTaskPaths: ReadonlyArray<string>;
  readonly taskChanged: boolean;
  readonly attributionChanged: boolean;
}): ProjectionSourceCacheSnapshot | null {
  const fastSnapshot = input.previousSnapshot && input.taskChanged && !input.attributionChanged
    ? refreshProjectionSourceCacheSnapshotForTouchedTaskPaths(
        input.rootInput,
        input.previousSnapshot,
        input.taskSource,
        input.touchedTaskPaths
      )
    : null;
  return fastSnapshot ?? captureProjectionSourceCacheSnapshot(
    input.rootInput,
    true,
    input.previousSnapshot,
    input.previousSnapshot
      ? { task: input.taskChanged, attribution: input.attributionChanged }
      : { task: true, attribution: true }
  );
}

/**
 * A projection generation reads this snapshot more than once per write (the
 * authored-source baseline warm start and the incremental updater both need it),
 * and on a large ledger one read is seconds of SQLite plus body verification.
 * The snapshot is a pure function of the database file, so it is memoized under
 * that file's stat signature: any projection write changes the signature and
 * retires the entry.
 */
const projectionSourceCacheReads = new Map<string, {
  readonly signature: string;
  readonly snapshot: ProjectionSourceCacheSnapshot;
}>();
const projectionSourceCacheReadLimit = 4;

export function readProjectionSourceCacheSnapshot(projectionPath: string): ProjectionSourceCacheSnapshot {
  const signature = projectionDatabaseFileSignature(projectionPath);
  const memoized = signature === null ? undefined : projectionSourceCacheReads.get(projectionPath);
  if (memoized && memoized.signature === signature) return memoized.snapshot;
  const snapshot = runSqliteReadonly(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`BEGIN`;
    try {
      const rows = projectionSourceCacheSnapshot(yield* readProjectionSourceCacheRows(sql));
      yield* sql`COMMIT`;
      return rows;
    } catch (error) {
      yield* sql`ROLLBACK`;
      throw error;
    }
  }));
  // Only memoize a read that observed a single stable database generation; a
  // concurrent projection write during the read leaves the snapshot unattributable.
  if (signature !== null && projectionDatabaseFileSignature(projectionPath) === signature) {
    projectionSourceCacheReads.delete(projectionPath);
    projectionSourceCacheReads.set(projectionPath, { signature, snapshot });
    while (projectionSourceCacheReads.size > projectionSourceCacheReadLimit) {
      const oldest = projectionSourceCacheReads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      projectionSourceCacheReads.delete(oldest);
    }
  }
  return snapshot;
}

export function readProjectionSourceCacheBody(
  projectionPath: string,
  cacheKindValue: ProjectionSourceCacheKind,
  sourcePath: string
): string | undefined {
  return runSqliteReadonly(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* readProjectionSourceCacheStoredBody(sql, cacheKindValue, sourcePath);
  }));
}

export function replaceProjectionSourceCacheRows(
  sql: SqlClient.SqlClient,
  snapshot: ProjectionSourceCacheSnapshot
): Effect.Effect<void, unknown> {
  return replaceProjectionSourceCacheStoredRows(sql, snapshot);
}

export function applyProjectionSourceCacheChange(
  sql: SqlClient.SqlClient,
  change: ProjectionSourceCacheChange
): Effect.Effect<void, unknown> {
  return applyProjectionSourceCacheStoredChange(sql, change);
}

export function buildProjectionSourceCacheChange(
  previous: ProjectionSourceCacheSnapshot,
  current: ProjectionSourceCacheSnapshot,
  changedKinds: ReadonlyArray<ProjectionSourceCacheKind> = ["task", "attribution"]
): ProjectionSourceCacheChange {
  const kinds = new Set(changedKinds);
  const currentFiles = new Map(current.files.filter((row) => kinds.has(row.cacheKind)).map((row) => [cachePathKey(row), row]));
  const previousFiles = new Map(previous.files.filter((row) => kinds.has(row.cacheKind)).map((row) => [cachePathKey(row), row]));
  const currentWatches = new Map(current.watches.filter((row) => kinds.has(row.cacheKind)).map((row) => [cachePathKey(row), row]));
  const previousWatches = new Map(previous.watches.filter((row) => kinds.has(row.cacheKind)).map((row) => [cachePathKey(row), row]));
  const previousMetadata = new Map(previous.metadata.map((row) => [row.cacheKind, row]));
  return {
    previous,
    current,
    deleteFiles: [...previousFiles].filter(([key]) => !currentFiles.has(key)).map(([, row]) => row),
    upsertFiles: [...currentFiles].filter(([key, row]) => !sameFileRow(previousFiles.get(key), row)).map(([, row]) => row),
    deleteWatches: [...previousWatches].filter(([key]) => !currentWatches.has(key)).map(([, row]) => row),
    upsertWatches: [...currentWatches].filter(([key, row]) => !sameWatchRow(previousWatches.get(key), row)).map(([, row]) => row),
    upsertMetadata: current.metadata.filter((row) => kinds.has(row.cacheKind) && previousMetadata.get(row.cacheKind)?.payloadSha256 !== row.payloadSha256)
  };
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
      yield* applyProjectionSourceCacheChange(sql, buildProjectionSourceCacheChange(previous, current));
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
}, validateBodies = true, reusableKindHashes: Readonly<Partial<Record<ProjectionSourceCacheKind, string>>> = {}, presorted = false): ProjectionSourceCacheSnapshot {
  const files = presorted ? input.files : [...input.files].sort(compareCachePaths);
  const watches = presorted ? input.watches : [...input.watches].sort(compareCachePaths);
  const metadata = [...input.metadata].sort((left, right) => left.cacheKind.localeCompare(right.cacheKind));
  assertCacheKinds(metadata.map((row) => row.cacheKind));
  if (validateBodies) for (const row of files) {
    if (!validSourceCacheBody(row)) throw new Error(`projection source cache body hash mismatch: ${row.sourcePath}`);
  }
  for (const row of metadata) {
    const expected = stablePayloadHash({ schema: "projection-source-cache-metadata-payload/v1", payloadJson: row.payloadJson });
    if (row.payloadSha256 !== expected) throw new Error(`projection source cache metadata hash mismatch: ${row.cacheKind}`);
  }
  const kindHashes = {
    attribution: reusableKindHashes.attribution ?? sourceCacheKindHash("attribution", files, watches, metadata),
    task: reusableKindHashes.task ?? sourceCacheKindHash("task", files, watches, metadata)
  };
  return {
    files,
    watches,
    metadata,
    kindHashes,
    hash: stablePayloadHash({
      schema: "projection-source-cache/v3",
      kindHashes
    })
  };
}

function validSourceCacheBody(row: ProjectionSourceCacheFileRow): boolean {
  if (sha256Text(row.body) === row.contentSha256) return true;
  // Attribution cache rows omit raw authored bodies and are reconstructed from
  // normalized, integrity-hashed event tables, so only identity is compared here.
  if (row.cacheKind !== "attribution" || !row.ownerId) return false;
  try {
    return decodeUnionAttributionEventBody(row.body).eventId === row.ownerId;
  } catch {
    return false;
  }
}

function sourceCacheKindHash(
  kind: ProjectionSourceCacheKind,
  files: ReadonlyArray<ProjectionSourceCacheFileRow>,
  watches: ReadonlyArray<ProjectionSourceCacheWatchRow>,
  metadata: ReadonlyArray<ProjectionSourceCacheMetadataRow>
): string {
  return sha256Text(JSON.stringify({
    schema: "projection-source-cache-kind/v2",
    cacheKind: kind,
    files: files
      .filter((row) => row.cacheKind === kind)
      .map((row) => [
        row.cacheKind,
        row.sourcePath,
        row.sourceKind,
        row.ownerId ?? null,
        row.statSignature,
        row.contentSha256
      ]),
    watches: watches
      .filter((row) => row.cacheKind === kind)
      .map((row) => [row.cacheKind, row.sourcePath, row.statSignature]),
    metadata: metadata
      .filter((row) => row.cacheKind === kind)
      .map((row) => [row.cacheKind, row.payloadSha256])
  }));
}

function metadataRow(cacheKind: ProjectionSourceCacheKind, payload: unknown): ProjectionSourceCacheMetadataRow {
  const payloadJson = JSON.stringify(payload);
  return {
    cacheKind,
    payloadJson,
    payloadSha256: stablePayloadHash({ schema: "projection-source-cache-metadata-payload/v1", payloadJson })
  };
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



function sameFileRow(left: ProjectionSourceCacheFileRow | undefined, right: ProjectionSourceCacheFileRow): boolean {
  return left !== undefined &&
    left.cacheKind === right.cacheKind &&
    left.sourcePath === right.sourcePath &&
    left.sourceKind === right.sourceKind &&
    left.ownerId === right.ownerId &&
    left.statSignature === right.statSignature &&
    left.contentSha256 === right.contentSha256;
}

function sameWatchRow(left: ProjectionSourceCacheWatchRow | undefined, right: ProjectionSourceCacheWatchRow): boolean {
  return left !== undefined && left.statSignature === right.statSignature;
}
