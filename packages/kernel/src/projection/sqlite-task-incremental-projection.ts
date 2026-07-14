import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../layout/index.ts";
import { readScalar } from "../markdown/frontmatter.ts";
import type { RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import { compareDecisionRows, hashDecisionProjectionRows, readDecisionProjectionRowsForPathsFromSource } from "./sqlite-decision-source.ts";
import {
  applyDeclaredProjectionDeltaToSnapshots,
  buildDeclaredProjectionDeltaFromSources,
  hashDeclaredSourceManifestRows,
  readDeclaredSourceManifestRows
} from "./sqlite-declared-source-manifest.ts";
import {
  readAttributionProjectionStateHash,
  readRelationGraphRows,
  projectionVersion,
  tryReadProjectionDatabase
} from "./sqlite-projection-store.ts";
import { updateProjectionDatabase } from "./sqlite-projection-update-store.ts";
import { buildAttributionProjectionDelta } from "./sqlite-attribution-projection.ts";
import {
  captureProjectionSourceCacheSnapshot,
  readProjectionSourceCacheSnapshot,
  restoreProjectionSourceCacheSnapshot
} from "./sqlite-projection-source-cache.ts";
import { compareRows, hashExactRows, readMarkdownSource, sourcePath, taskEntryToRow } from "./sqlite-task-source.ts";
import {
  rebuildTaskProjection
} from "./sqlite-task-projection.ts";
import {
  readCachedProjectionValidation,
  rememberProjectionValidation
} from "./sqlite-projection-validation-cache.ts";
import {
  captureProjectionSourceFingerprint,
  hashDeclaredProjectionSnapshots,
  hashProjectionLegacyPersonIds,
  readDeclaredProjectionSnapshots
} from "./projection-source-snapshot.ts";
import type { DecisionProjectionRow, ProjectionReadResult, TaskProjectionOptions, TaskProjectionRow } from "./types.ts";

export function updateTaskProjectionIncrementally(options: TaskProjectionOptions & {
  readonly touchedPaths: ReadonlyArray<string>;
  readonly previousSourceFingerprint?: string;
}): ProjectionReadResult & { readonly mode: "incremental" | "rebuild" | "unchanged" } {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;

  if (!existsSync(projectionPath)) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }

  const existing = tryReadProjectionDatabase(projectionPath, options.taskFieldExtensions);
  if (!existing.ok) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  if (existing.meta.version !== projectionVersion) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const cachedValidation = readCachedProjectionValidation(projectionPath);
  let persistedSourceCache: ReturnType<typeof readProjectionSourceCacheSnapshot> | undefined;
  if (!cachedValidation) {
    try {
      persistedSourceCache = readVerifiedProjectionSourceCache(projectionPath, existing.meta.sourceCacheHash);
      const restored = restoreProjectionSourceCacheSnapshot(runtimeContext, persistedSourceCache);
      if (!restored.valid) throw new Error("projection source cache payload invalid");
    } catch {
      return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
    }
  }
  let declaredManifest: ReturnType<typeof readDeclaredSourceManifestRows>;
  let existingDeclaredTables: ReturnType<typeof readDeclaredProjectionSnapshots>;
  let attributionRowsHash: string;
  try {
    declaredManifest = cachedValidation?.declaredManifest ?? readDeclaredSourceManifestRows(projectionPath);
    existingDeclaredTables = readDeclaredProjectionSnapshots(projectionPath);
    attributionRowsHash = cachedValidation
      ? existing.meta.attributionRowsHash ?? ""
      : readAttributionProjectionStateHash(projectionPath);
  } catch {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  if (!projectionRowsMatchMeta(existing, existingDeclaredTables, declaredManifest, attributionRowsHash)) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const snapshot = captureProjectionSourceFingerprint(runtimeContext, declaredManifest);
  const source = snapshot.taskSource;
  const sourceHash = snapshot.fingerprint;

  const oldGraph = safeReadRelationGraphRows(projectionPath);
  const declaredEntityOnly = options.touchedPaths.length > 0 && options.touchedPaths
    .every((filePath) => isDeclaredEntityFile(resolveHarnessLayout(runtimeContext).authoredRoot, realPathIfExists(filePath)));
  const newGraph = declaredEntityOnly || options.touchedPaths.length === 0
    ? null
    : buildRelationGraphProjection(runtimeContext, snapshot.taskSource.sourceInputs);
  const affected = affectedProjectionEntities({
    rootDir,
    rootInput: runtimeContext,
    touchedPaths: options.touchedPaths,
    sourceEntries: source.entries,
    existingRows: existing.rows,
    existingDecisionRows: existing.decisionRows,
    oldEdges: oldGraph.relationEdges,
    newEdges: newGraph?.edges ?? oldGraph.relationEdges
  });
  let declaredDelta: ReturnType<typeof buildDeclaredProjectionDeltaFromSources>;
  try {
    declaredDelta = buildDeclaredProjectionDeltaFromSources(runtimeContext, declaredManifest, snapshot.declaredSources);
  } catch {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const hasDeclaredDelta = declaredDelta.tables.length > 0 ||
    declaredDelta.manifest.deleteSourcePaths.length > 0 ||
    declaredDelta.manifest.upsertRows.length > 0;

  if (existing.meta.sourceHash === sourceHash && !hasAffectedProjectionEntities(affected) && !hasDeclaredDelta) {
    return {
      rows: [...existing.rows].sort(compareRows),
      warnings: source.warnings,
      mode: "unchanged"
    };
  }

  if (existing.meta.sourceHash !== sourceHash && existing.meta.sourceHash !== options.previousSourceFingerprint) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }

  const taskChange = incrementalTaskRows(runtimeContext, source.entries, existing.rows, affected.taskIds, options.taskFieldExtensions);
  const decisionChange = incrementalDecisionRows(
    runtimeContext,
    existing.decisionRows,
    affected.decisionIds,
    affected.decisionPaths,
    source.sourceInputs
  );
  const rowsHash = hashExactRows(taskChange.rows);
  const decisionRowsHash = hashDecisionProjectionRows(decisionChange.rows);
  const declaredRowsHash = hashDeclaredProjectionSnapshots(
    applyDeclaredProjectionDeltaToSnapshots(existingDeclaredTables, declaredDelta)
  );
  const declaredManifestHash = hashDeclaredSourceManifestRows(declaredDelta.manifest.currentRows);
  let verifiedSourceHash: string;
  try {
    verifiedSourceHash = captureProjectionSourceFingerprint(
      runtimeContext,
      declaredDelta.manifest.currentRows
    ).fingerprint;
  } catch {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  if (verifiedSourceHash !== sourceHash) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const sourceCacheNeedsRefresh = existing.meta.taskSourceHash !== snapshot.taskSource.hash ||
    existing.meta.attributionSourceHash !== snapshot.attributionSource.hash;
  if (sourceCacheNeedsRefresh && !persistedSourceCache) {
    try {
      persistedSourceCache = readVerifiedProjectionSourceCache(projectionPath, existing.meta.sourceCacheHash);
    } catch {
      return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
    }
  }
  const sourceCache = sourceCacheNeedsRefresh ? captureProjectionSourceCacheSnapshot(runtimeContext) : null;
  if (sourceCacheNeedsRefresh && !sourceCache) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const sourceCacheChange = sourceCache && persistedSourceCache && sourceCache.hash !== persistedSourceCache.hash
    ? { previous: persistedSourceCache, current: sourceCache }
    : undefined;
  const attributionChanged = existing.meta.attributionSourceHash !== snapshot.attributionSource.hash;
  let attributionDelta: ReturnType<typeof buildAttributionProjectionDelta> | undefined;
  if (attributionChanged) {
    if (!sourceCacheChange) {
      return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
    }
    attributionDelta = buildAttributionProjectionDelta(sourceCacheChange);
  }

  updateProjectionDatabase(projectionPath, {
    deleteTaskIds: [...taskChange.deleteIds],
    upsertTaskRows: taskChange.currentRows,
    deleteDecisionIds: [...decisionChange.deleteIds],
    upsertDecisionRows: decisionChange.currentRows,
    meta: {
      sourceHash,
      rowsHash,
      decisionRowsHash,
      declaredRowsHash,
      declaredManifestHash,
      attributionRowsHash: existing.meta.attributionRowsHash,
      attributionSourceHash: snapshot.attributionSource.hash,
      taskSourceHash: snapshot.taskSource.hash,
      sourceCacheHash: sourceCache?.hash ?? existing.meta.sourceCacheHash,
      legacyPersonIdsHash: hashProjectionLegacyPersonIds(snapshot.legacyPersonIds)
    },
    ...(newGraph ? { graphRows: {
      relationEdges: newGraph.edges,
      coverageRows: newGraph.coverageRows,
      factAnchors: newGraph.factAnchors,
      factRows: newGraph.factRows,
      warnings: newGraph.warnings
    } } : {}),
    declaredDelta,
    ...(sourceCacheChange ? { sourceCache: sourceCacheChange } : {}),
    ...(attributionDelta ? { attributionDelta } : {}),
    taskFieldExtensions: options.taskFieldExtensions
  });
  rememberProjectionValidation(projectionPath, declaredDelta.manifest.currentRows);

  return {
    rows: taskChange.rows,
    warnings: source.warnings,
    mode: "incremental"
  };
}

function readVerifiedProjectionSourceCache(
  projectionPath: string,
  expectedHash: string | undefined
): ReturnType<typeof readProjectionSourceCacheSnapshot> {
  const snapshot = readProjectionSourceCacheSnapshot(projectionPath);
  if (snapshot.hash !== expectedHash) throw new Error("projection source cache hash mismatch");
  return snapshot;
}

function hasAffectedProjectionEntities(affected: {
  readonly taskIds: ReadonlySet<string>;
  readonly decisionIds: ReadonlySet<string>;
  readonly decisionPaths: ReadonlySet<string>;
}): boolean {
  return affected.taskIds.size > 0 || affected.decisionIds.size > 0 || affected.decisionPaths.size > 0;
}

function projectionRowsMatchMeta(existing: {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly decisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly meta: {
    readonly rowsHash: string;
    readonly decisionRowsHash?: string;
    readonly declaredRowsHash?: string;
    readonly declaredManifestHash?: string;
    readonly attributionRowsHash?: string;
  };
}, declaredTables: ReturnType<typeof readDeclaredProjectionSnapshots>, declaredManifest: ReturnType<typeof readDeclaredSourceManifestRows>, attributionRowsHash: string): boolean {
  return existing.meta.rowsHash === hashExactRows(existing.rows) &&
    (existing.meta.decisionRowsHash ?? "") === hashDecisionProjectionRows(existing.decisionRows) &&
    (existing.meta.declaredRowsHash ?? "") === hashDeclaredProjectionSnapshots(declaredTables) &&
    (existing.meta.declaredManifestHash ?? "") === hashDeclaredSourceManifestRows(declaredManifest) &&
    (existing.meta.attributionRowsHash ?? "") === attributionRowsHash;
}

function safeReadRelationGraphRows(projectionPath: string): {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
} {
  try {
    return readRelationGraphRows(projectionPath);
  } catch {
    return { relationEdges: [] };
  }
}

function incrementalTaskRows(
  rootInput: Parameters<typeof taskEntryToRow>[0],
  entries: ReturnType<typeof readMarkdownSource>["entries"],
  existingRows: ReadonlyArray<TaskProjectionRow>,
  affectedTaskIds: ReadonlySet<string>,
  taskFieldExtensions: TaskProjectionOptions["taskFieldExtensions"]
): {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly currentRows: ReadonlyArray<TaskProjectionRow>;
  readonly deleteIds: ReadonlySet<string>;
} {
  const currentRows = entries
    .filter((entry) => affectedTaskIds.has(entry.taskId) || affectedTaskIds.has(readScalar(entry.frontmatter, "task_id") || entry.taskId))
    .map((entry) => taskEntryToRow(rootInput, entry, taskFieldExtensions));
  const deleteIds = new Set([...affectedTaskIds, ...currentRows.map((row) => row.taskId)]);
  return {
    rows: [
      ...existingRows.filter((row) => !deleteIds.has(row.taskId)),
      ...currentRows
    ].sort(compareRows),
    currentRows,
    deleteIds
  };
}

function incrementalDecisionRows(
  rootInput: Parameters<typeof readDecisionProjectionRowsForPathsFromSource>[0],
  existingRows: ReadonlyArray<DecisionProjectionRow>,
  affectedDecisionIds: ReadonlySet<string>,
  affectedDecisionPaths: ReadonlySet<string>,
  sourceInputs: ReturnType<typeof readMarkdownSource>["sourceInputs"]
): {
  readonly rows: ReadonlyArray<DecisionProjectionRow>;
  readonly currentRows: ReadonlyArray<DecisionProjectionRow>;
  readonly deleteIds: ReadonlySet<string>;
} {
  const currentRows = readDecisionProjectionRowsForPathsFromSource(rootInput, [...affectedDecisionPaths], sourceInputs);
  const deleteIds = new Set([...affectedDecisionIds, ...currentRows.map((row) => row.decisionId)]);
  return {
    rows: [
      ...existingRows.filter((row) => !deleteIds.has(row.decisionId)),
      ...currentRows
    ].sort(compareDecisionRows),
    currentRows,
    deleteIds
  };
}

function affectedProjectionEntities(input: {
  readonly rootDir: string;
  readonly rootInput: Parameters<typeof resolveHarnessLayout>[0];
  readonly touchedPaths: ReadonlyArray<string>;
  readonly sourceEntries: ReturnType<typeof readMarkdownSource>["entries"];
  readonly existingRows: ReadonlyArray<TaskProjectionRow>;
  readonly existingDecisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly oldEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly newEdges: ReadonlyArray<RelationGraphEdgeRow>;
}): {
  readonly taskIds: ReadonlySet<string>;
  readonly decisionIds: ReadonlySet<string>;
  readonly decisionPaths: ReadonlySet<string>;
} {
  const layout = resolveHarnessLayout(input.rootInput);
  const rootDir = realPathIfExists(input.rootDir);
  const tasksRoot = realPathIfExists(layout.tasksRoot);
  const decisionsRoot = realPathIfExists(layout.decisionsRoot);
  const taskIds = new Set<string>();
  const decisionIds = new Set<string>();
  const decisionPaths = new Set<string>();
  const touchedRelativePaths = new Set(input.touchedPaths.map((filePath) => sourcePath(rootDir, realPathIfExists(filePath))));
  const declaredEntityRelativePaths = new Set(input.touchedPaths
    .map(realPathIfExists)
    .filter((filePath) => isDeclaredEntityFile(layout.authoredRoot, filePath))
    .map((filePath) => sourcePath(rootDir, filePath)));
  const taskTouchedRelativePaths = [...touchedRelativePaths]
    .filter((relativePath) => !declaredEntityRelativePaths.has(relativePath));

  for (const filePath of input.touchedPaths) {
    const resolved = realPathIfExists(filePath);
    const taskSlug = taskSlugForPath(tasksRoot, resolved);
    if (taskSlug && !isDeclaredEntityFile(layout.authoredRoot, resolved)) taskIds.add(taskSlug);
    if (path.basename(resolved) === "decision.md" && isPathWithin(decisionsRoot, resolved)) {
      decisionPaths.add(path.join(input.rootDir, sourcePath(rootDir, resolved)));
    }
  }

  for (const entry of input.sourceEntries) {
    const entrySourcePath = sourcePath(rootDir, realPathIfExists(entry.indexPath));
    if (taskTouchedRelativePaths.some((relativePath) => relativePath === entrySourcePath || relativePath.startsWith(`${path.posix.dirname(entrySourcePath)}/`))) {
      taskIds.add(entry.taskId);
    }
  }

  for (const row of input.existingRows) {
    if (taskTouchedRelativePaths.some((relativePath) => relativePath === row.sourcePath || relativePath.startsWith(`${path.posix.dirname(row.sourcePath)}/`))) {
      taskIds.add(row.taskId);
    }
  }

  for (const row of input.existingDecisionRows) {
    if (touchedRelativePaths.has(row.path)) {
      decisionIds.add(row.decisionId);
      decisionPaths.add(path.join(input.rootDir, row.path));
    }
  }

  for (const edge of [...input.oldEdges, ...input.newEdges]) {
    if (!touchedRelativePaths.has(edge.sourcePath)) continue;
    addEntityRef(edge.sourceRef, taskIds, decisionIds);
    addEntityRef(edge.targetRef, taskIds, decisionIds);
  }

  for (const row of input.existingDecisionRows) {
    if (decisionIds.has(row.decisionId)) decisionPaths.add(path.join(input.rootDir, row.path));
  }

  return { taskIds, decisionIds, decisionPaths };
}

function taskSlugForPath(tasksRoot: string, filePath: string): string | undefined {
  if (!isPathWithin(tasksRoot, filePath)) return undefined;
  const relative = path.relative(tasksRoot, filePath);
  const [slug] = relative.split(path.sep);
  return slug && slug.length > 0 ? slug : undefined;
}

function isDeclaredEntityFile(authoredRoot: string, filePath: string): boolean {
  if (!isPathWithin(authoredRoot, filePath)) return false;
  const relative = path.relative(realPathIfExists(authoredRoot), realPathIfExists(filePath)).split(path.sep).join("/");
  return /^sessions\/[^/]+\.md$/u.test(relative) ||
    /^tasks\/[^/]+\/(?:executions|reviews)\/[^/]+\.md$/u.test(relative);
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(realPathIfExists(parent), realPathIfExists(child));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPathIfExists(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function addEntityRef(ref: string, taskIds: Set<string>, decisionIds: Set<string>): void {
  const [kind, id] = ref.split("/");
  if (kind === "task" && id) taskIds.add(id);
  if (kind === "decision" && id) decisionIds.add(id);
  if (kind === "fact") {
    const ownerTaskId = ref.split("/")[1];
    if (ownerTaskId) taskIds.add(ownerTaskId);
  }
}
