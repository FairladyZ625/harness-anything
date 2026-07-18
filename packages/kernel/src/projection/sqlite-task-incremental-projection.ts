import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../layout/index.ts";
import { readScalar } from "../markdown/frontmatter.ts";
import type { RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import { relationGraphFactProjectionSemanticHash, relationGraphSourceSemanticHash } from "./relation-graph-source-semantics.ts";
import { compareDecisionRows, hashDecisionProjectionRows, readDecisionProjectionRowsForPathsFromSource } from "./sqlite-decision-source.ts";
import {
  buildDeclaredProjectionDeltaFromSources,
  declaredProjectionRowsMatchManifest,
  hashDeclaredProjectionIntegrityRows,
  hashDeclaredSourceManifestRows,
  readDeclaredSourceManifestRows
} from "./sqlite-declared-source-manifest.ts";
import {
  readAttributionProjectionStateHash,
  readRelationGraphReuseSeed,
  projectionVersion,
  tryReadProjectionDatabase
} from "./sqlite-projection-store.ts";
import { updateProjectionDatabase } from "./sqlite-projection-update-store.ts";
import { buildAttributionProjectionDelta } from "./sqlite-attribution-projection.ts";
import {
  buildProjectionSourceCacheChange,
  readProjectionSourceCacheBody,
  readProjectionSourceCacheSnapshot,
  refreshProjectionSourceCacheAfterIncrementalChange,
  restoreProjectionSourceCacheSnapshot
} from "./sqlite-projection-source-cache.ts";
import { compareRows, hashExactRows, hashExactSortedRows, readMarkdownSource, sourcePath, taskEntryToRow } from "./sqlite-task-source.ts";
import {
  rebuildTaskProjection
} from "./sqlite-task-projection.ts";
import {
  readCachedProjectionValidation,
  rememberProjectionValidation
} from "./sqlite-projection-validation-cache.ts";
import {
  captureProjectionSourceFingerprint,
  hashProjectionLegacyPersonIds,
  readDeclaredProjectionSnapshots
} from "./projection-source-snapshot.ts";
import type { DecisionProjectionRow, TaskProjectionOptions, TaskProjectionRow } from "./types.ts";
import {
  declaredProjectionEntityChanges,
  projectionChange,
  type IncrementalTaskProjectionResult
} from "./projection-change-event.ts";

export interface IncrementalProjectionPhase {
  readonly phase: "load-current" | "capture-source" | "derive-affected" | "declared-delta" | "hash-next" | "verify-source" | "source-delta" | "publish";
  readonly milliseconds: number;
}

export function updateTaskProjectionIncrementally(options: TaskProjectionOptions & {
  readonly touchedPaths: ReadonlyArray<string>;
  readonly previousSourceFingerprint?: string;
  readonly onPhase?: (phase: IncrementalProjectionPhase) => void;
}): IncrementalTaskProjectionResult {
  let phaseStarted = performance.now();
  const recordPhase = (phase: IncrementalProjectionPhase["phase"]): void => {
    const now = performance.now();
    options.onPhase?.({ phase, milliseconds: now - phaseStarted });
    phaseStarted = now;
  };
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;

  if (!existsSync(projectionPath)) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }

  const cachedValidation = readCachedProjectionValidation(projectionPath);
  const cachedProjection = cachedValidation?.projection;
  const existing = cachedProjection
    ? { ok: true as const, ...cachedProjection }
    : tryReadProjectionDatabase(projectionPath, options.taskFieldExtensions);
  if (!existing.ok) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  if (existing.meta.version !== projectionVersion) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  let persistedSourceCache: ReturnType<typeof readProjectionSourceCacheSnapshot> | undefined = cachedValidation?.sourceCache;
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
  let existingDeclaredTables: ReturnType<typeof readDeclaredProjectionSnapshots> | undefined;
  let attributionRowsHash: string;
  try {
    declaredManifest = cachedValidation?.declaredManifest ?? readDeclaredSourceManifestRows(projectionPath);
    existingDeclaredTables = cachedValidation ? undefined : readDeclaredProjectionSnapshots(projectionPath);
    attributionRowsHash = cachedValidation
      ? existing.meta.attributionRowsHash ?? ""
      : readAttributionProjectionStateHash(projectionPath);
  } catch {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  if (!cachedProjection && !projectionRowsMatchMeta(existing, existingDeclaredTables, declaredManifest, attributionRowsHash)) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  recordPhase("load-current");
  const authoredRoot = resolveHarnessLayout(runtimeContext).authoredRoot;
  const attributionEventsRoot = resolveHarnessLayout(runtimeContext).attributionEventsRoot;
  const declaredEntityOnly = options.touchedPaths.length > 0 && options.touchedPaths
    .every((filePath) => isDeclaredEntityFile(authoredRoot, realPathIfExists(filePath)));
  const touchedDeclaredPaths = declaredEntityOnly ? options.touchedPaths : [];
  const touchesDeclared = options.touchedPaths.some((filePath) => isDeclaredEntityFile(authoredRoot, realPathIfExists(filePath)));
  const touchesAttribution = options.touchedPaths.some((filePath) => isPathWithin(attributionEventsRoot, realPathIfExists(filePath)));
  const touchesTaskSource = options.touchedPaths.some((filePath) =>
    !isDeclaredEntityFile(authoredRoot, realPathIfExists(filePath)) &&
    !isPathWithin(attributionEventsRoot, realPathIfExists(filePath)));
  const touchedTaskPaths = touchesTaskSource
    ? options.touchedPaths.filter((filePath) =>
      !isDeclaredEntityFile(authoredRoot, realPathIfExists(filePath)) &&
      !isPathWithin(attributionEventsRoot, realPathIfExists(filePath)))
    : [];
  const sourceCacheReuse = options.previousSourceFingerprint ? {
    task: !touchesTaskSource,
    declared: !touchesDeclared,
    attribution: !touchesAttribution,
    validateReusedTaskDirectories: false,
    validateReusedDeclaredDirectories: false,
    touchedTaskPaths
  } : {};
  const snapshot = captureProjectionSourceFingerprint(
    runtimeContext,
    declaredManifest,
    options.previousSourceFingerprint && options.touchedPaths.length > 0 ? "verify" : "stable",
    touchedDeclaredPaths,
    sourceCacheReuse
  );
  recordPhase("capture-source");
  const source = snapshot.taskSource;
  const sourceHash = snapshot.fingerprint;

  const graphSourceChange = declaredEntityOnly
    ? { changed: false, factProjectionReusable: false }
    : relationGraphSourceChange(
    rootDir,
    projectionPath,
    options.touchedPaths,
    snapshot.taskSource.sourceInputs
  );
  const reusableGraph = declaredEntityOnly || !graphSourceChange.changed
    ? null
    : safeReadRelationGraphReuseSeed(projectionPath);
  if (graphSourceChange.changed && reusableGraph === null) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const oldGraph = reusableGraph ?? { relationEdges: [], factRefs: new Set<string>() };
  const preserveGraphFactRows = graphSourceChange.changed && graphSourceChange.factProjectionReusable && reusableGraph !== null;
  const newGraph = declaredEntityOnly || !graphSourceChange.changed || options.touchedPaths.length === 0
    ? null
    : preserveGraphFactRows
      ? buildRelationGraphProjection(runtimeContext, snapshot.taskSource.sourceInputs, oldGraph.factRefs)
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
  recordPhase("derive-affected");
  let declaredDelta: ReturnType<typeof buildDeclaredProjectionDeltaFromSources>;
  try {
    declaredDelta = buildDeclaredProjectionDeltaFromSources(runtimeContext, declaredManifest, snapshot.declaredSources);
  } catch {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const hasDeclaredDelta = declaredDelta.tables.length > 0 ||
    declaredDelta.manifest.deleteSourcePaths.length > 0 ||
    declaredDelta.manifest.upsertRows.length > 0;
  recordPhase("declared-delta");

  if (existing.meta.sourceHash === sourceHash && !hasAffectedProjectionEntities(affected) && !hasDeclaredDelta) {
    return {
      rows: [...existing.rows].sort(compareRows),
      warnings: source.warnings,
      mode: "unchanged",
      sourceHash,
      change: projectionChange(sourceHash, [])
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
  const rowsHash = taskChange.currentRows.length === 0 && taskChange.deleteIds.size === 0
    ? existing.meta.rowsHash
    : hashExactSortedRows(taskChange.rows);
  const decisionRowsHash = decisionChange.currentRows.length === 0 && decisionChange.deleteIds.size === 0
    ? existing.meta.decisionRowsHash ?? hashDecisionProjectionRows(decisionChange.rows)
    : hashDecisionProjectionRows(decisionChange.rows);
  const declaredRowsHash = hashDeclaredProjectionIntegrityRows(declaredDelta.manifest.currentRows);
  const declaredManifestHash = hashDeclaredSourceManifestRows(declaredDelta.manifest.currentRows);
  recordPhase("hash-next");
  let verifiedSource: ReturnType<typeof captureProjectionSourceFingerprint>;
  try {
    verifiedSource = captureProjectionSourceFingerprint(
      runtimeContext,
      declaredDelta.manifest.currentRows,
      "verify",
      touchedDeclaredPaths,
      sourceCacheReuse
    );
    if (verifiedSource.declaredSources.some(({ source: declaredSource }) => !declaredSource.stats.cacheHit) &&
        readMarkdownSource(runtimeContext, "verify").hash !== verifiedSource.taskSource.hash) {
      return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
    }
  } catch {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  if (verifiedSource.fingerprint !== sourceHash) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  recordPhase("verify-source");
  const taskSourceCacheChanged = existing.meta.taskSourceHash !== snapshot.taskSource.hash;
  const attributionSourceCacheChanged = existing.meta.attributionSourceHash !== snapshot.attributionSource.hash;
  const sourceCacheNeedsRefresh = taskSourceCacheChanged || attributionSourceCacheChanged;
  if (sourceCacheNeedsRefresh && !persistedSourceCache) {
    try {
      persistedSourceCache = readVerifiedProjectionSourceCache(projectionPath, existing.meta.sourceCacheHash);
    } catch {
      return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
    }
  }
  const sourceCache = sourceCacheNeedsRefresh ? refreshProjectionSourceCacheAfterIncrementalChange({
    rootInput: runtimeContext,
    previousSnapshot: persistedSourceCache,
    taskSource: snapshot.taskSource,
    touchedTaskPaths,
    taskChanged: taskSourceCacheChanged,
    attributionChanged: attributionSourceCacheChanged
  }) : null;
  if (sourceCacheNeedsRefresh && !sourceCache) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }
  const sourceCacheChange = sourceCache && persistedSourceCache && sourceCache.hash !== persistedSourceCache.hash
    ? buildProjectionSourceCacheChange(
      persistedSourceCache,
      sourceCache,
      [
        ...(taskSourceCacheChanged ? ["task" as const] : []),
        ...(attributionSourceCacheChanged ? ["attribution" as const] : [])
      ]
    )
    : undefined;
  const attributionChanged = existing.meta.attributionSourceHash !== snapshot.attributionSource.hash;
  let attributionDelta: ReturnType<typeof buildAttributionProjectionDelta> | undefined;
  if (attributionChanged) {
    if (!sourceCacheChange) {
      return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
    }
    attributionDelta = buildAttributionProjectionDelta(sourceCacheChange);
  }
  recordPhase("source-delta");

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
    }, preserveGraphFactRows } : {}),
    declaredDelta,
    ...(sourceCacheChange ? { sourceCache: sourceCacheChange } : {}),
    ...(attributionDelta ? { attributionDelta } : {}),
    taskFieldExtensions: options.taskFieldExtensions
  });
  recordPhase("publish");
  rememberProjectionValidation(
    projectionPath,
    declaredDelta.manifest.currentRows,
    undefined,
    sourceCache ?? persistedSourceCache
  );

  return {
    rows: taskChange.rows,
    warnings: source.warnings,
    mode: "incremental",
    sourceHash,
    change: projectionChange(sourceHash, [
      ...[...affected.taskIds].map((id) => ({ kind: "task", id })),
      ...[...affected.decisionIds].map((id) => ({ kind: "decision", id })),
      ...declaredProjectionEntityChanges(declaredManifest, declaredDelta)
    ])
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
}, declaredTables: ReturnType<typeof readDeclaredProjectionSnapshots> | undefined, declaredManifest: ReturnType<typeof readDeclaredSourceManifestRows>, attributionRowsHash: string): boolean {
  return existing.meta.rowsHash === hashExactRows(existing.rows) &&
    (existing.meta.decisionRowsHash ?? "") === hashDecisionProjectionRows(existing.decisionRows) &&
    (existing.meta.declaredRowsHash ?? "") === hashDeclaredProjectionIntegrityRows(declaredManifest) &&
    (declaredTables === undefined || declaredProjectionRowsMatchManifest(declaredTables, declaredManifest)) &&
    (existing.meta.declaredManifestHash ?? "") === hashDeclaredSourceManifestRows(declaredManifest) &&
    (existing.meta.attributionRowsHash ?? "") === attributionRowsHash;
}

function safeReadRelationGraphReuseSeed(projectionPath: string): {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly factRefs: ReadonlySet<string>;
} | null {
  try {
    return readRelationGraphReuseSeed(projectionPath);
  } catch {
    return null;
  }
}

function relationGraphSourceChange(
  rootDir: string,
  projectionPath: string,
  touchedPaths: ReadonlyArray<string>,
  sourceInputs: ReturnType<typeof readMarkdownSource>["sourceInputs"]
): { readonly changed: boolean; readonly factProjectionReusable: boolean } {
  const currentBodies = new Map(sourceInputs.map((input) => [input.sourcePath, input.body]));
  const normalizedRoot = realPathIfExists(rootDir);
  let changed = false;
  let factProjectionReusable = true;
  for (const touchedPath of touchedPaths) {
    const relativePath = sourcePath(normalizedRoot, realPathIfExists(touchedPath));
    const currentBody = currentBodies.get(relativePath);
    const previousBody = readProjectionSourceCacheBody(projectionPath, "task", relativePath);
    if (currentBody === undefined || previousBody === undefined) {
      changed = true;
      factProjectionReusable = false;
      continue;
    }
    if (relationGraphSourceSemanticHash(relativePath, previousBody) ===
        relationGraphSourceSemanticHash(relativePath, currentBody)) continue;
    changed = true;
    if (relationGraphFactProjectionSemanticHash(relativePath, previousBody) !==
        relationGraphFactProjectionSemanticHash(relativePath, currentBody)) factProjectionReusable = false;
  }
  return { changed, factProjectionReusable };
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
  if (affectedTaskIds.size === 0) {
    return { rows: existingRows, currentRows: [], deleteIds: new Set() };
  }
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
  if (affectedDecisionIds.size === 0 && affectedDecisionPaths.size === 0) {
    return { rows: existingRows, currentRows: [], deleteIds: new Set() };
  }
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
  const tasksRootRelativePath = sourcePath(rootDir, tasksRoot);
  const taskPackageTouchedRelativePaths = taskTouchedRelativePaths.filter((relativePath) =>
    relativePath === tasksRootRelativePath || relativePath.startsWith(`${tasksRootRelativePath}/`));

  for (const filePath of input.touchedPaths) {
    const resolved = realPathIfExists(filePath);
    const taskSlug = taskSlugForPath(tasksRoot, resolved);
    if (taskSlug && !isDeclaredEntityFile(layout.authoredRoot, resolved)) taskIds.add(taskSlug);
    if (path.basename(resolved) === "decision.md" && isPathWithin(decisionsRoot, resolved)) {
      decisionPaths.add(path.join(input.rootDir, sourcePath(rootDir, resolved)));
    }
  }

  for (const relativePath of taskPackageTouchedRelativePaths) {
    const entry = input.sourceEntries.find((candidate) => {
      const entrySourcePath = sourcePath(path.resolve(input.rootDir), path.resolve(candidate.indexPath));
      return relativePath === entrySourcePath || relativePath.startsWith(`${path.posix.dirname(entrySourcePath)}/`);
    });
    if (entry) taskIds.add(entry.taskId);

    const row = input.existingRows.find((candidate) =>
      relativePath === candidate.sourcePath || relativePath.startsWith(`${path.posix.dirname(candidate.sourcePath)}/`));
    if (row) taskIds.add(row.taskId);
  }

  if (taskPackageTouchedRelativePaths.length > 1) {
    for (const entry of input.sourceEntries) {
      const entrySourcePath = sourcePath(path.resolve(input.rootDir), path.resolve(entry.indexPath));
      if (taskPackageTouchedRelativePaths.some((relativePath) => relativePath === entrySourcePath || relativePath.startsWith(`${path.posix.dirname(entrySourcePath)}/`))) {
        taskIds.add(entry.taskId);
      }
    }

    for (const row of input.existingRows) {
      if (taskPackageTouchedRelativePaths.some((relativePath) => relativePath === row.sourcePath || relativePath.startsWith(`${path.posix.dirname(row.sourcePath)}/`))) {
        taskIds.add(row.taskId);
      }
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
    /^tasks\/[^/]+\/(?:executions|consents|reviews)\/[^/]+\.md$/u.test(relative);
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(realPathIfExists(parent), realPathIfExists(child));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPathIfExists(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    const missingSegments: string[] = [];
    let existingParent = path.resolve(filePath);
    while (!existsSync(existingParent)) {
      const parent = path.dirname(existingParent);
      if (parent === existingParent) return path.resolve(filePath);
      missingSegments.unshift(path.basename(existingParent));
      existingParent = parent;
    }
    try {
      return path.join(realpathSync.native(existingParent), ...missingSegments);
    } catch {
      return path.resolve(filePath);
    }
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
