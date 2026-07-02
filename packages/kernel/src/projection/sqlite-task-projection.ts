import { existsSync } from "node:fs";
import path from "node:path";
import { createHarnessRuntimeContext } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { buildCheckReport, hardFail, runPostMergeChecks, warning } from "./post-merge-checks.ts";
import { writeProjectionDatabase, tryReadProjectionDatabase } from "./sqlite-projection-store.ts";
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
  TaskProjectionOptions,
  TaskProjectionRow
} from "./types.ts";
import type { ProjectionCheckResult, ProjectionReadResult, TaskProjectionOptions } from "./types.ts";

export function defaultTaskProjectionPath(rootDir: string): string {
  return resolveHarnessLayout(rootDir).projectionPath;
}

export function rebuildTaskProjection(options: TaskProjectionOptions): ProjectionReadResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const source = readMarkdownSource(runtimeContext);
  const rows = source.entries.map((entry) => taskEntryToRow(runtimeContext, entry)).sort(compareRows);
  const rowsHash = hashExactRows(rows);
  writeProjectionDatabase(projectionPath, rows, {
    sourceHash: source.hash,
    rowsHash
  });
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
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath });
    return { rows: rebuilt.rows, warnings };
  }

  const existing = tryReadProjectionDatabase(projectionPath);
  if (!existing.ok) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projection cache could not be read and has been rebuilt from markdown.",
      "Discard the generated cache and rebuild it from authored markdown; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  if (existing.meta.sourceHash !== source.hash) {
    warnings.push(warning(
      "generated-cache",
      "projection_stale",
      "Projection cache was stale and has been rebuilt from markdown.",
      "Run harness-anything governance rebuild after authored task changes or merges."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  const actualRowsHash = hashExactRows(existing.rows);
  if (existing.meta.rowsHash !== actualRowsHash) {
    warnings.push(hardFail(
      "generated-cache",
      "projection_tampered",
      "Projection rows no longer match their recorded hash.",
      "Discard the generated cache and rebuild it from authored markdown; do not merge generated projection edits."
    ));
    const rebuilt = rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath });
    return { rows: rebuilt.rows, warnings: [...warnings, ...rebuilt.warnings] };
  }

  return {
    rows: [...existing.rows].sort(compareRows),
    warnings
  };
}

export function checkTaskProjection(options: TaskProjectionOptions): ProjectionCheckResult {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const result = readTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath });
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
