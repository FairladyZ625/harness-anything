import { existsSync } from "node:fs";
import path from "node:path";
import { createHarnessRuntimeContext } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { sessionEntityDeclaration } from "../entity/session.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { isContractVersionCompatible } from "../domain/contract-version.ts";
import {
  discoverDeclaredEntityRows,
  projectDeclaredEntities,
  readDeclaredProjectionRows,
} from "./entity-declaration-projection.ts";
import { buildCheckReport, hardFail, runPostMergeChecks, warning } from "./post-merge-checks.ts";
import { buildColdCoverage, readColdRebuildSource } from "./cold-rebuild-source.ts";
import type {
  FactAnchorRow,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
} from "./relation-graph-projection.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import {
  projectionVersion,
  queryTaskChildrenRows,
  readRebuildableRelationProjection,
  writeProjectionDatabase,
  tryReadProjectionDatabase,
} from "./sqlite-projection-store.ts";
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
  TaskFieldExtensionProjection,
  TaskProjectionQueryFilters,
  TaskProjectionOptions,
  TaskProjectionRow,
} from "./types.ts";
import type { ProjectionCheckResult, ProjectionReadResult, TaskProjectionOptions } from "./types.ts";

export function defaultTaskProjectionPath(rootDir: string): string {
  return resolveHarnessLayout(rootDir).projectionPath;
}

export function rebuildTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath
    ? path.resolve(options.projectionPath)
    : resolveHarnessLayout(runtimeContext).projectionPath;
  const source = readMarkdownSource(runtimeContext);
  const rows = source.entries
    .map((entry) => taskEntryToRow(runtimeContext, entry, options.taskFieldExtensions))
    .sort(compareRows);
  const rowsHash = hashExactRows(rows);
  const sourceHash = projectionSourceHash(source.hash, runtimeContext);
  // The canonical ledger may still contain task-local fact references until the
  // one-time genesis migration runs. Reuse the migration reader's normalizer
  // so a resident daemon never rebuilds a partial relation graph in that window.
  const cold = readColdRebuildSource(runtimeContext, { includeLegacyTaskFacts: true }),
    graphBase = buildRelationGraphProjection(runtimeContext, cold.truth),
    graph = { ...graphBase, coverageRows: buildColdCoverage(cold, graphBase.edges) };
  writeProjectionDatabase(
    projectionPath,
    rows,
    {
      sourceHash,
      rowsHash,
    },
    options.taskFieldExtensions ?? [],
    { ...graph, facts: cold.facts, decisions: cold.decisions, truthComplete: cold.complete },
  );
  projectDeclaredEntities(runtimeContext, sessionEntityDeclaration, projectionPath);
  return {
    rows,
    warnings: source.warnings,
  };
}

export function readTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath
    ? path.resolve(options.projectionPath)
    : resolveHarnessLayout(runtimeContext).projectionPath;
  const source = readMarkdownSource(runtimeContext);
  const warnings = [...source.warnings];

  if (!existsSync(projectionPath)) {
    warnings.push(
      warning(
        "generated-cache",
        "projection_missing",
        "Projection cache was missing and has been rebuilt.",
        "Run harness-anything governance rebuild to materialize a fresh local projection cache before relying on generated state.",
      ),
    );
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return { rows: rebuilt.rows, warnings };
  }

  const existing = tryReadProjectionDatabase(projectionPath, options.taskFieldExtensions);
  if (!existing.ok) {
    warnings.push(
      hardFail(
        "generated-cache",
        "projection_tampered",
        "Projection cache could not be read and has been rebuilt from markdown.",
        "Discard the generated cache and rebuild it from authored markdown; do not merge generated projection edits.",
      ),
    );
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (!isContractVersionCompatible(existing.meta.version, projectionVersion)) {
    warnings.push(
      warning(
        "generated-cache",
        "projection_stale",
        "Projection cache schema version was stale and has been rebuilt from markdown.",
        "Run harness-anything governance rebuild after upgrading projection schema.",
      ),
    );
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (existing.meta.sourceHash !== projectionSourceHash(source.hash, runtimeContext)) {
    warnings.push(
      warning(
        "generated-cache",
        "projection_stale",
        "Projection cache was stale and has been rebuilt from markdown.",
        "Run harness-anything governance rebuild after authored task changes or merges.",
      ),
    );
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (!declaredProjectionMatches(runtimeContext, projectionPath)) {
    warnings.push(
      hardFail(
        "generated-cache",
        "projection_tampered",
        "Declared entity projection rows no longer match authored entity state.",
        "Discard the generated cache and rebuild it from authored entities; do not merge generated projection edits.",
      ),
    );
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const actualRowsHash = hashExactRows(existing.rows);
  if (existing.meta.rowsHash !== actualRowsHash) {
    warnings.push(
      hardFail(
        "generated-cache",
        "projection_tampered",
        "Projection rows no longer match their recorded hash.",
        "Discard the generated cache and rebuild it from authored markdown; do not merge generated projection edits.",
      ),
    );
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  return {
    rows: [...existing.rows].sort(compareRows),
    warnings,
  };
}

function projectionSourceHash(
  taskSourceHash: string,
  rootInput: ReturnType<typeof createHarnessRuntimeContext>,
): string {
  const entityRows = [sessionEntityDeclaration].map((declaration) => ({
    table: declaration.projection.table,
    rows: discoverDeclaredEntityRows(rootInput, declaration),
  }));
  return sha256Text(JSON.stringify({ taskSourceHash, entityRows }));
}

function declaredProjectionMatches(
  rootInput: ReturnType<typeof createHarnessRuntimeContext>,
  projectionPath: string,
): boolean {
  try {
    return [sessionEntityDeclaration].every(
      (declaration) =>
        JSON.stringify(readDeclaredProjectionRows(projectionPath, declaration)) ===
        JSON.stringify(discoverDeclaredEntityRows(rootInput, declaration)),
    );
  } catch {
    return false;
  }
}

export function queryTaskChildren(
  options: TaskProjectionOptions & { readonly parentTaskId: string },
): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath
    ? path.resolve(options.projectionPath)
    : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readTaskProjection({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    projectionPath,
    taskFieldExtensions: options.taskFieldExtensions,
  });
  try {
    return {
      rows: queryTaskChildrenRows(projectionPath, options.parentTaskId),
      warnings: projection.warnings,
    };
  } catch {
    const rebuilt = rebuildTaskProjection({
      rootDir,
      layoutOverrides: options.layoutOverrides,
      projectionPath,
      taskFieldExtensions: options.taskFieldExtensions,
    });
    return {
      rows: queryTaskChildrenRows(projectionPath, options.parentTaskId),
      warnings: [...projection.warnings, ...rebuilt.warnings],
    };
  }
}

export function readRelationGraphProjection(options: TaskProjectionOptions): {
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly factAnchors: ReadonlyArray<FactAnchorRow>;
  readonly facts: ReadonlyArray<RelationFactRow>;
  readonly taskRows: ProjectionReadResult["rows"];
  readonly warnings: ProjectionReadResult["warnings"];
} {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath
    ? path.resolve(options.projectionPath)
    : resolveHarnessLayout(runtimeContext).projectionPath;
  const projection = readRebuildableRelationProjection(projectionPath);
  if (!projection.ok)
    return {
      edges: [],
      coverageRows: [],
      factAnchors: [],
      facts: [],
      taskRows: [],
      warnings: [
        hardFail(
          "generated-cache",
          "relation_truth_unavailable",
          projection.reason,
          "Materialize the rebuild relation projection before serving graph reads; never rebuild the canonical cache from a read request.",
        ),
      ],
    };
  return {
    edges: projection.edges,
    coverageRows: projection.coverageRows,
    factAnchors: projection.factAnchors,
    facts: projection.facts,
    taskRows: projection.taskRows,
    warnings: [],
  };
}

export function checkTaskProjection(options: TaskProjectionOptions): ProjectionCheckResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath
    ? path.resolve(options.projectionPath)
    : resolveHarnessLayout(runtimeContext).projectionPath;
  const result = readTaskProjection({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    projectionPath,
    taskFieldExtensions: options.taskFieldExtensions,
  });
  const postMergeWarnings = options.postMerge
    ? runPostMergeChecks(runtimeContext, options.eventRelationTruth ?? null)
    : [];
  const warnings = [...result.warnings, ...postMergeWarnings];
  const ok = warnings.every((item) => item.severity !== "hard-fail");
  return {
    ok,
    projectionPath,
    report: buildCheckReport(ok, result.rows.length, warnings),
    rows: result.rows,
    warnings,
  };
}
