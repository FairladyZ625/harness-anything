import { existsSync } from "node:fs";
import path from "node:path";
import { createHarnessRuntimeContext } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { executionDeclaration } from "../entity/execution-declaration.ts";
import { reviewDeclaration } from "../entity/review-declaration.ts";
import { sessionEntityDeclaration } from "../entity/session.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { discoverDeclaredEntityRows, projectDeclaredEntities, readDeclaredProjectionRows } from "./entity-declaration-projection.ts";
import { buildCheckReport, hardFail, runPostMergeChecks, warning } from "./post-merge-checks.ts";
import type { FactAnchorRow, RelationCoverageRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import { projectionVersion, queryDecisionProjectionRows, queryTaskChildrenRows, queryTaskProjectionRows, queryTaskSubtreeRows, readRelationGraphRows, writeProjectionDatabase, tryReadProjectionDatabase } from "./sqlite-projection-store.ts";
import { compareDecisionRows, hashDecisionProjectionRows, readDecisionProjectionRows } from "./sqlite-decision-source.ts";
import { materializeAttributionProjection } from "./sqlite-attribution-projection.ts";
import { attributionEventSourceHash } from "../local/attribution-event-source.ts";
import { readLegacyPersonIds } from "./entity-attribution-projection.ts";
import { compareRows, hashExactRows, readMarkdownSource, taskEntryToRow } from "./sqlite-task-source.ts";
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
  const source = readMarkdownSource(runtimeContext);
  const rows = source.entries.map((entry) => taskEntryToRow(runtimeContext, entry, options.taskFieldExtensions)).sort(compareRows);
  const decisionRows = readDecisionProjectionRows(runtimeContext);
  const rowsHash = hashExactRows(rows);
  const decisionRowsHash = hashDecisionProjectionRows(decisionRows);
  const sourceHash = projectionSourceHash(source.hash, runtimeContext);
  const relationGraph = buildRelationGraphProjection(runtimeContext);
  writeProjectionDatabase(projectionPath, rows, decisionRows, {
    sourceHash,
    rowsHash,
    decisionRowsHash
  }, {
    relationEdges: relationGraph.edges,
    coverageRows: relationGraph.coverageRows,
    factAnchors: relationGraph.factAnchors
  }, options.taskFieldExtensions);
  projectDeclaredEntities(runtimeContext, sessionEntityDeclaration, projectionPath);
  projectDeclaredEntities(runtimeContext, executionDeclaration, projectionPath);
  projectDeclaredEntities(runtimeContext, reviewDeclaration, projectionPath);
  materializeAttributionProjection(runtimeContext, projectionPath);
  return {
    rows,
    warnings: source.warnings
  };
}

export function readTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const source = readMarkdownSource(runtimeContext);
  const warnings = [...source.warnings];

  if (!existsSync(projectionPath)) {
    warnings.push(warning(
      "generated-cache",
      "projection_missing",
      "Projection cache was missing and has been rebuilt.",
      "Run harness-anything governance rebuild to materialize a fresh local projection cache before relying on generated state."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings };
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

  if (existing.meta.sourceHash !== projectionSourceHash(source.hash, runtimeContext)) {
    warnings.push(warning(
      "generated-cache",
      "projection_stale",
      "Projection cache was stale and has been rebuilt from markdown.",
      "Run harness-anything governance rebuild after authored task changes or merges."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (!declaredProjectionMatches(runtimeContext, projectionPath)) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Declared entity projection rows no longer match authored entity state.",
      "Discard the generated cache and rebuild it from authored entities; do not merge generated projection edits."
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

  const currentDecisionRowsHash = hashDecisionProjectionRows(readDecisionProjectionRows(runtimeContext));
  if ((existing.meta.decisionRowsHash ?? "") !== currentDecisionRowsHash) {
    warnings.push(warning(
      "generated-cache",
      "projection_stale",
      "Projection decision cache was stale and has been rebuilt from markdown.",
      "Run harness-anything governance rebuild after authored decision changes or merges."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  return {
    rows: [...existing.rows].sort(compareRows),
    warnings
  };
}

function projectionSourceHash(taskSourceHash: string, rootInput: ReturnType<typeof createHarnessRuntimeContext>): string {
  const entityRows = [sessionEntityDeclaration, executionDeclaration, reviewDeclaration].map((declaration) => ({
    table: declaration.projection.table,
    rows: discoverDeclaredEntityRows(rootInput, declaration)
  }));
  return sha256Text(JSON.stringify({
    taskSourceHash,
    entityRows,
    attributionEventSourceHash: attributionEventSourceHash(rootInput),
    legacyPersonIds: [...readLegacyPersonIds(rootInput)].sort()
  }));
}

function declaredProjectionMatches(rootInput: ReturnType<typeof createHarnessRuntimeContext>, projectionPath: string): boolean {
  try {
    return [sessionEntityDeclaration, executionDeclaration, reviewDeclaration].every((declaration) =>
      JSON.stringify(readDeclaredProjectionRows(projectionPath, declaration)) ===
      JSON.stringify(discoverDeclaredEntityRows(rootInput, declaration))
    );
  } catch {
    return false;
  }
}

export function queryTaskProjection(options: TaskProjectionOptions & { readonly filters: TaskProjectionQueryFilters }): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    return {
      rows: queryTaskProjectionRows(projectionPath, options.filters, options.taskFieldExtensions),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: queryTaskProjectionRows(projectionPath, options.filters, options.taskFieldExtensions),
      warnings: [...projection.warnings, ...rebuilt.warnings]
    };
  }
}

export function queryTaskChildren(options: TaskProjectionOptions & { readonly parentTaskId: string }): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
  try {
    return {
      rows: queryTaskChildrenRows(projectionPath, options.parentTaskId),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: queryTaskChildrenRows(projectionPath, options.parentTaskId),
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
      rows: queryTaskSubtreeRows(projectionPath, options.rootTaskId),
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    return {
      rows: queryTaskSubtreeRows(projectionPath, options.rootTaskId),
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
      warnings: taskProjection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    const graphRows = readRelationGraphRows(projectionPath);
    return {
      edges: graphRows.relationEdges,
      coverageRows: graphRows.coverageRows,
      factAnchors: graphRows.factAnchors,
      warnings: [...taskProjection.warnings, ...rebuilt.warnings]
    };
  }
}

export function readTriadicProjectionSnapshot(options: TaskProjectionOptions): {
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
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
      warnings: projection.warnings
    };
  } catch {
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions });
    const graph = readRelationGraphRows(projectionPath);
    return {
      decisions: queryDecisionProjectionRows(projectionPath, {}),
      edges: graph.relationEdges,
      coverageRows: graph.coverageRows,
      factAnchors: graph.factAnchors,
      warnings: [...projection.warnings, ...rebuilt.warnings]
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
