import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { createHarnessRuntimeContext } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { replaceDeclaredProjectionRows } from "./entity-declaration-projection.ts";
import { buildCheckReport, hardFail, runPostMergeChecks, warning } from "./post-merge-checks.ts";
import type { FactAnchorRow, RelationCoverageRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import {
  projectionVersion,
  queryDecisionProjectionRows,
  queryTaskChildrenRows,
  queryTaskProjectionRows,
  queryTaskSubtreeRows,
  readAttributionProjectionStateHash,
  readRelationGraphRows,
  writeProjectionDatabase,
  tryReadProjectionDatabase
} from "./sqlite-projection-store.ts";
import { compareDecisionRows, hashDecisionProjectionRows } from "./sqlite-decision-source.ts";
import {
  buildDeclaredProjectionDeltaFromSources,
  declaredProjectionRowsMatchManifest,
  declaredSourceManifestRows,
  hashDeclaredProjectionIntegrityRows,
  hashDeclaredSourceManifestRows,
  readDeclaredSourceManifestRows,
  replaceDeclaredSourceManifestRows
} from "./sqlite-declared-source-manifest.ts";
import { updateProjectionDatabase } from "./sqlite-projection-update-store.ts";
import {
  captureProjectionSourceCacheSnapshot,
  readProjectionSourceCacheSnapshot,
  replaceProjectionSourceCacheRows,
  restoreProjectionSourceCacheSnapshot,
  updateProjectionSourceCacheSnapshot,
  type ProjectionSourceCacheSnapshot
} from "./sqlite-projection-source-cache.ts";
import {
  readCachedProjectionValidation,
  rememberProjectionValidation
} from "./sqlite-projection-validation-cache.ts";
import { materializeEntityAttributionBlocks, replaceAttributionProjectionRows } from "./sqlite-attribution-projection.ts";
import { compareRows, hashExactRows, taskEntryToRow } from "./sqlite-task-source.ts";
import { deriveTaskProjectionRows } from "./task-read-derivations.ts";
import {
  captureProjectionSourceFingerprint,
  captureProjectionSourceSnapshot,
  hashProjectionLegacyPersonIds,
  readDeclaredProjectionSnapshots
} from "./projection-source-snapshot.ts";
export { hashTaskProjectionRows } from "./sqlite-task-source.ts";
export type {
  CoordinationStatus,
  ProjectionCanonicalStatus,
  ProjectionCheckAxisReport,
  ProjectionCheckReport,
  ProjectionCheckResult,
  ProjectionFreshness,
  ProjectionReadResult,
  ProjectionSource,
  ProjectionWarning,
  ProjectionWarningCode,
  ProjectionWarningSeverity,
  ProjectionWarningSource,
  DecisionProjectionQueryFilters,
  DecisionProjectionRow,
  TaskFieldExtensionProjection,
  TaskLiveness,
  TaskProjectionQueryFilters,
  TaskProjectionOptions,
  TaskProjectionRow
} from "./types.ts";
import type {
  DecisionProjectionQueryFilters,
  DecisionProjectionRow,
  ProjectionCheckResult,
  ProjectionReadResult,
  TaskProjectionOptions,
  TaskProjectionQueryFilters
} from "./types.ts";

export function defaultTaskProjectionPath(rootDir: string): string {
  return resolveHarnessLayout(rootDir).projectionPath;
}

export function rebuildTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const stableBuild = captureStableProjectionBuild(runtimeContext);
  const snapshot = stableBuild.snapshot;
  const source = snapshot.taskSource;
  const rows = source.entries.map((entry) => taskEntryToRow(runtimeContext, entry, options.taskFieldExtensions)).sort(compareRows);
  const decisionRows = snapshot.decisionRows;
  const rowsHash = hashExactRows(rows);
  const decisionRowsHash = hashDecisionProjectionRows(decisionRows);
  const declaredManifestRows = declaredSourceManifestRows(snapshot.declaredTables, snapshot.declaredSources);
  const declaredRowsHash = hashDeclaredProjectionIntegrityRows(declaredManifestRows);
  const declaredManifestHash = hashDeclaredSourceManifestRows(declaredManifestRows);
  const relationGraph = stableBuild.relationGraph;
  const sourceCache = stableBuild.sourceCache;
  writeProjectionDatabase(projectionPath, rows, decisionRows, {
    sourceHash: snapshot.fingerprint,
    rowsHash,
    decisionRowsHash,
    declaredRowsHash,
    declaredManifestHash,
    attributionSourceHash: snapshot.attributionSource.hash,
    taskSourceHash: snapshot.taskSource.hash,
    sourceCacheHash: sourceCache.hash,
    legacyPersonIdsHash: hashProjectionLegacyPersonIds(snapshot.legacyPersonIds)
  }, {
    relationEdges: relationGraph.edges,
    coverageRows: relationGraph.coverageRows,
    factAnchors: relationGraph.factAnchors,
    factRows: relationGraph.factRows,
    warnings: relationGraph.warnings
  }, options.taskFieldExtensions, (sql) => Effect.gen(function* () {
    for (const table of snapshot.declaredTables) {
      yield* replaceDeclaredProjectionRows(sql, table.declaration, table.rows);
    }
    yield* replaceDeclaredSourceManifestRows(sql, declaredManifestRows);
    yield* replaceProjectionSourceCacheRows(sql, sourceCache);
    yield* replaceAttributionProjectionRows(sql, snapshot.attributionEvents);
    yield* materializeEntityAttributionBlocks(sql, snapshot.attributionEvents);
  }));
  rememberProjectionValidation(projectionPath, declaredManifestRows, undefined, sourceCache);
  const persisted = tryReadProjectionDatabase(projectionPath, options.taskFieldExtensions);
  return {
    rows: deriveTaskProjectionRows(runtimeContext, persisted.ok ? persisted.rows : rows),
    warnings: source.warnings
  };
}

function captureStableProjectionBuild(runtimeContext: ReturnType<typeof createHarnessRuntimeContext>): {
  readonly snapshot: ReturnType<typeof captureProjectionSourceSnapshot>;
  readonly relationGraph: ReturnType<typeof buildRelationGraphProjection>;
  readonly sourceCache: ProjectionSourceCacheSnapshot;
} {
  let lastFailure: unknown = new Error("projection authored sources did not stabilize during rebuild");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const snapshot = captureProjectionSourceSnapshot(runtimeContext);
      const relationGraph = buildRelationGraphProjection(runtimeContext, snapshot.taskSource.sourceInputs);
      const verified = captureProjectionSourceFingerprint(runtimeContext, [], "verify");
      const sourceCache = captureProjectionSourceCacheSnapshot(runtimeContext, true);
      if (verified.fingerprint === snapshot.fingerprint && sourceCache) return { snapshot, relationGraph, sourceCache };
      lastFailure = new Error("projection authored sources did not stabilize during rebuild");
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure;
}

export function readTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const warnings: ProjectionReadResult["warnings"][number][] = [];

  if (!existsSync(projectionPath)) {
    warnings.push(warning(
      "generated-cache",
      "projection_missing",
      "Projection cache was missing and has been rebuilt.",
      "Run harness-anything governance rebuild to materialize a fresh local projection cache before relying on generated state."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const existing = tryReadProjectionDatabase(projectionPath, options.taskFieldExtensions);
  if (!existing.ok) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projection cache could not be read and has been rebuilt from markdown.",
      "Discard the generated cache and rebuild it from authored markdown; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (existing.meta.version !== projectionVersion) {
    warnings.push(warning(
      "generated-cache",
      "projection_stale",
      "Projection cache schema version was stale and has been rebuilt from markdown.",
      "Run harness-anything governance rebuild after upgrading projection schema."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const cachedValidation = readCachedProjectionValidation(projectionPath);
  let persistedSourceCache: ProjectionSourceCacheSnapshot | null = null;
  if (!cachedValidation) {
    try {
      persistedSourceCache = readProjectionSourceCacheSnapshot(projectionPath);
      if (existing.meta.sourceCacheHash !== persistedSourceCache.hash) throw new Error("projection source cache hash mismatch");
      const restored = restoreProjectionSourceCacheSnapshot(runtimeContext, persistedSourceCache);
      if (!restored.valid) throw new Error("projection source cache payload invalid");
    } catch {
      warnings.push(hardFail(
        "generated-cache",
        "projection_tampered",
        "Projection source cache no longer matches its recorded hash.",
        "Discard the generated cache and rebuild it from authored state; do not merge generated projection edits."
      ));
      const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
      return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
    }
  }
  let declaredManifest: ReturnType<typeof readDeclaredSourceManifestRows>;
  try {
    declaredManifest = cachedValidation?.declaredManifest ?? readDeclaredSourceManifestRows(projectionPath);
  } catch {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projection source manifest could not be read and has been rebuilt from authored state.",
      "Discard the generated cache and rebuild it from authored entities; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }
  if (!cachedValidation && existing.meta.declaredManifestHash !== hashDeclaredSourceManifestRows(declaredManifest)) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projection source manifest no longer matches its recorded hash.",
      "Discard the generated cache and rebuild it from authored entities; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const snapshot = captureProjectionSourceFingerprint(runtimeContext, declaredManifest);
  const source = snapshot.taskSource;
  warnings.push(...source.warnings);

  let existingDeclaredTables: ReturnType<typeof readDeclaredProjectionSnapshots> | null = null;
  if (!cachedValidation) {
    try {
      existingDeclaredTables = readDeclaredProjectionSnapshots(projectionPath);
    } catch {
      existingDeclaredTables = null;
    }
  }
  if (!cachedValidation && (
    existingDeclaredTables === null ||
    existing.meta.declaredRowsHash !== hashDeclaredProjectionIntegrityRows(declaredManifest) ||
    !declaredProjectionRowsMatchManifest(existingDeclaredTables, declaredManifest)
  )) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Declared entity projection rows no longer match authored entity state.",
      "Discard the generated cache and rebuild it from authored entities; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  let attributionRowsMatch = true;
  if (!cachedValidation) {
    try {
      attributionRowsMatch = existing.meta.attributionRowsHash === readAttributionProjectionStateHash(projectionPath);
    } catch {
      attributionRowsMatch = false;
    }
  }
  if (!attributionRowsMatch) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projected attribution no longer matches its recorded hash.",
      "Discard the generated cache and rebuild it from authored attribution events; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const actualRowsHash = hashExactRows(existing.rows);
  const actualDecisionRowsHash = hashDecisionProjectionRows(existing.decisionRows);
  if (existing.meta.rowsHash !== actualRowsHash || existing.meta.decisionRowsHash !== actualDecisionRowsHash) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projection rows no longer match their recorded hash.",
      "Discard the generated cache and rebuild it from authored markdown; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (existing.meta.sourceHash !== snapshot.fingerprint) {
    const legacyPersonIdsHash = hashProjectionLegacyPersonIds(snapshot.legacyPersonIds);
    const declaredOnly = existing.meta.taskSourceHash === snapshot.taskSource.hash &&
      existing.meta.attributionSourceHash === snapshot.attributionSource.hash &&
      existing.meta.legacyPersonIdsHash === legacyPersonIdsHash;
    if (declaredOnly) {
      try {
        const declaredDelta = buildDeclaredProjectionDeltaFromSources(runtimeContext, declaredManifest, snapshot.declaredSources);
        updateProjectionDatabase(projectionPath, {
          deleteTaskIds: [],
          upsertTaskRows: [],
          deleteDecisionIds: [],
          upsertDecisionRows: [],
          meta: {
            ...existing.meta,
            sourceHash: snapshot.fingerprint,
            declaredRowsHash: hashDeclaredProjectionIntegrityRows(declaredDelta.manifest.currentRows),
            declaredManifestHash: hashDeclaredSourceManifestRows(declaredDelta.manifest.currentRows)
          },
          declaredDelta,
          taskFieldExtensions: options.taskFieldExtensions
        });
        rememberProjectionValidation(
          projectionPath,
          declaredDelta.manifest.currentRows,
          undefined,
          cachedValidation?.sourceCache ?? persistedSourceCache ?? undefined
        );
        warnings.push(warning(
          "generated-cache",
          "projection_stale",
          "Declared entity projection changes were refreshed incrementally.",
          "No full projection rebuild is required for isolated session, execution, consent, or review changes."
        ));
        return { rows: [...existing.rows].sort(compareRows), warnings };
      } catch {
        // Fall through to the safe full rebuild when the manifest delta cannot be proven.
      }
    }
    warnings.push(warning(
      "generated-cache",
      "projection_stale",
      "Projection cache was stale and has been rebuilt from markdown.",
      "Run harness-anything governance rebuild after authored task changes or merges."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const currentSourceCache = persistedSourceCache ? captureProjectionSourceCacheSnapshot(runtimeContext) : null;
  if (persistedSourceCache && currentSourceCache && currentSourceCache.hash !== persistedSourceCache.hash) {
    updateProjectionSourceCacheSnapshot(projectionPath, persistedSourceCache, currentSourceCache);
  }
  if (!cachedValidation?.projection || !cachedValidation.sourceCache) {
    rememberProjectionValidation(
      projectionPath,
      declaredManifest,
      existing,
      cachedValidation?.sourceCache ?? persistedSourceCache ?? undefined
    );
  }

  return {
    rows: deriveTaskProjectionRows(runtimeContext, [...existing.rows].sort(compareRows)),
    warnings
  };
}

export function queryTaskProjection(options: TaskProjectionOptions & { readonly filters: TaskProjectionQueryFilters }): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    return {
      rows: derivedFilteredRows(runtimeContext, projection.rows, queryTaskProjectionRows(projectionPath, baseTaskFilters(options.filters), options.taskFieldExtensions), options),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: derivedFilteredRows(runtimeContext, rebuilt.rows, queryTaskProjectionRows(projectionPath, baseTaskFilters(options.filters), options.taskFieldExtensions), options),
      warnings: [...projection.warnings, ...rebuilt.warnings]
    };
  }
}

function baseTaskFilters(filters: TaskProjectionQueryFilters): TaskProjectionQueryFilters {
  const { treeRoot: _treeRoot, liveness: _liveness, ...base } = filters;
  return base;
}

function derivedFilteredRows(
  rootInput: ReturnType<typeof createHarnessRuntimeContext>,
  universe: ReadonlyArray<import("./types.ts").TaskProjectionRow>,
  rows: ReadonlyArray<import("./types.ts").TaskProjectionRow>,
  options: TaskProjectionOptions & { readonly filters: TaskProjectionQueryFilters }
): ReadonlyArray<import("./types.ts").TaskProjectionRow> {
  return deriveTaskProjectionRows(rootInput, rows, {
    universe
  }).filter((row) => (!options.filters.treeRoot || row.treeRoot === options.filters.treeRoot) &&
    (!options.filters.liveness || row.liveness === options.filters.liveness));
}

export function queryTaskChildren(options: TaskProjectionOptions & { readonly parentTaskId: string }): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    return {
      rows: deriveTaskProjectionRows(runtimeContext, queryTaskChildrenRows(projectionPath, options.parentTaskId), { universe: projection.rows }),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: deriveTaskProjectionRows(runtimeContext, queryTaskChildrenRows(projectionPath, options.parentTaskId), { universe: rebuilt.rows }),
      warnings: [...projection.warnings, ...rebuilt.warnings]
    };
  }
}

export function queryTaskSubtree(options: TaskProjectionOptions & { readonly rootTaskId: string }): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    return {
      rows: deriveTaskProjectionRows(runtimeContext, queryTaskSubtreeRows(projectionPath, options.rootTaskId), { universe: projection.rows }),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: deriveTaskProjectionRows(runtimeContext, queryTaskSubtreeRows(projectionPath, options.rootTaskId), { universe: rebuilt.rows }),
      warnings: [...projection.warnings, ...rebuilt.warnings]
    };
  }
}

export function queryDecisionProjection(options: TaskProjectionOptions & { readonly filters: DecisionProjectionQueryFilters }): {
  readonly rows: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ProjectionReadResult["warnings"];
} {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    return {
      rows: [...queryDecisionProjectionRows(projectionPath, options.filters)].sort(compareDecisionRows),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: [...queryDecisionProjectionRows(projectionPath, options.filters)].sort(compareDecisionRows),
      warnings: [...projection.warnings, ...rebuilt.warnings]
    };
  }
}

export function readRelationGraphProjection(options: TaskProjectionOptions): {
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly factRows: ReturnType<typeof readRelationGraphRows>["factRows"];
  readonly warnings: ProjectionReadResult["warnings"];
} {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const taskProjection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    const graphRows = readRelationGraphRows(projectionPath);
    return {
      edges: graphRows.relationEdges,
      coverageRows: graphRows.coverageRows,
      factAnchors: graphRows.factAnchors,
      factRows: graphRows.factRows,
      warnings: [...taskProjection.warnings, ...graphRows.warnings]
    };
  } catch {
    const readWarning = hardFail(
      "generated-cache",
      "projection_tampered",
      "Relation or fact projection rows could not be decoded and were rebuilt from authored state.",
      "Discard the generated cache and rebuild it from authored markdown; do not trust unreadable projection rows."
    );
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    const graphRows = readRelationGraphRows(projectionPath);
    return {
      edges: graphRows.relationEdges,
      coverageRows: graphRows.coverageRows,
      factAnchors: graphRows.factAnchors,
      factRows: graphRows.factRows,
      warnings: [...taskProjection.warnings, readWarning, ...rebuilt.warnings, ...graphRows.warnings]
    };
  }
}

export function readTriadicProjectionSnapshot(options: TaskProjectionOptions): {
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly facts: ReturnType<typeof readRelationGraphRows>["factRows"];
  readonly warnings: ProjectionReadResult["warnings"];
} {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    const graph = readRelationGraphRows(projectionPath);
    return {
      decisions: queryDecisionProjectionRows(projectionPath, {}),
      edges: graph.relationEdges,
      coverageRows: graph.coverageRows,
      factAnchors: graph.factAnchors,
      facts: graph.factRows,
      warnings: [...projection.warnings, ...graph.warnings]
    };
  } catch {
    const readWarning = hardFail(
      "generated-cache",
      "projection_tampered",
      "Triadic relation or fact projection rows could not be decoded and were rebuilt from authored state.",
      "Discard the generated cache and rebuild it from authored markdown; do not trust unreadable projection rows."
    );
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    const graph = readRelationGraphRows(projectionPath);
    return {
      decisions: queryDecisionProjectionRows(projectionPath, {}),
      edges: graph.relationEdges,
      coverageRows: graph.coverageRows,
      factAnchors: graph.factAnchors,
      facts: graph.factRows,
      warnings: [...projection.warnings, readWarning, ...rebuilt.warnings, ...graph.warnings]
    };
  }
}

export function readDecisionFactCoverage(options: TaskProjectionOptions & { readonly decisionId: string }): {
  readonly rows: ReadonlyArray<RelationCoverageRow>;
  readonly warnings: ProjectionReadResult["warnings"];
} {
  const projection = readRelationGraphProjection(options);
  const decisionRef = `decision/${options.decisionId}`;
  return {
    rows: projection.coverageRows.filter((row) => row.decisionRef === decisionRef),
    warnings: projection.warnings
  };
}

export function checkTaskProjection(options: TaskProjectionOptions): ProjectionCheckResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const result = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  const postMergeWarnings = options.postMerge ? runPostMergeChecks(runtimeContext) : [];
  const warnings = [...result.warnings, ...postMergeWarnings];
  const ok = warnings.every((item) => item.severity !== "hard-fail");
  return {
    ok,
    projectionPath,
    report: buildCheckReport(ok, result.rows.length, warnings),
    rows: result.rows,
    warnings
  };
}
