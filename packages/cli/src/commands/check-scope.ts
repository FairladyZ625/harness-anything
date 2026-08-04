import path from "node:path";
import { checkTaskProjection, resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel";
import { relativePath } from "../cli/path.ts";
import type { CheckScope } from "../cli/types.ts";
import type { ProfileValidationIssue } from "./check-profile-types.ts";

type TaskProjectionResult = ReturnType<typeof checkTaskProjection>;
type TaskProjectionRow = TaskProjectionResult["rows"][number];
type ProjectionWarning = TaskProjectionResult["warnings"][number];

export interface ResolvedCheckScope {
  readonly kind: CheckScope["kind"];
  readonly value: string;
  readonly taskIds: ReadonlySet<string>;
  readonly taskDirs: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  readonly matchTokens: ReadonlyArray<string>;
}

export function resolveCheckScope(
  rootInput: HarnessLayoutInput,
  requested: CheckScope,
  rows: ReadonlyArray<TaskProjectionRow>
): ResolvedCheckScope | undefined {
  const layout = resolveHarnessLayout(rootInput);
  let selected: ReadonlyArray<TaskProjectionRow>;
  if (requested.kind === "task-tree") {
    if (!rows.some((row) => row.taskId === requested.taskId)) return undefined;
    const taskIds = new Set([requested.taskId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!row.parentTaskId || !taskIds.has(row.parentTaskId) || taskIds.has(row.taskId)) continue;
        taskIds.add(row.taskId);
        changed = true;
      }
    }
    selected = rows.filter((row) => taskIds.has(row.taskId));
  } else {
    selected = rows.filter((row) => pathsIntersect(requested.path, path.posix.dirname(row.sourcePath)));
    if (selected.length === 0) return undefined;
  }
  const taskDirs = [...new Set(selected.map((row) => path.dirname(path.resolve(layout.rootDir, row.sourcePath))))].sort();
  const taskIds = new Set(selected.map((row) => row.taskId));
  const relativeTaskDirs = taskDirs.map((taskDir) => relativePath(layout.rootDir, taskDir));
  return {
    kind: requested.kind,
    value: requested.kind === "task-tree" ? requested.taskId : requested.path,
    taskIds,
    taskDirs,
    paths: relativeTaskDirs,
    matchTokens: [...taskIds, ...relativeTaskDirs]
  };
}

export function scopedProjection(projection: TaskProjectionResult, scope: ResolvedCheckScope): TaskProjectionResult {
  const rows = projection.rows.filter((row) => scope.taskIds.has(row.taskId));
  const warnings = projection.warnings.filter((warning) => projectionWarningMatchesScope(warning, scope));
  const hardFailCount = warnings.filter((warning) => warning.severity === "hard-fail").length;
  const ok = hardFailCount === 0;
  const axisReport = (axis: ProjectionWarning["source"]) => {
    const axisWarnings = warnings.filter((warning) => warning.source === axis);
    return {
      axis,
      ok: axisWarnings.every((warning) => warning.severity !== "hard-fail"),
      warningCount: axisWarnings.length,
      hardFailCount: axisWarnings.filter((warning) => warning.severity === "hard-fail").length,
      codes: [...new Set(axisWarnings.map((warning) => warning.code))].sort()
    };
  };
  return {
    ...projection,
    ok,
    rows,
    warnings,
    report: {
      schema: "harness-check-report/v1",
      ok,
      axes: [
        axisReport("source-package"),
        axisReport("generated-cache"),
        axisReport("collaboration-gate")
      ],
      summary: {
        rowCount: rows.length,
        warningCount: warnings.length,
        hardFailCount
      }
    }
  };
}

export function filterIssuesForScope(
  issues: ReadonlyArray<ProfileValidationIssue>,
  scope: ResolvedCheckScope | undefined
): ReadonlyArray<ProfileValidationIssue> {
  if (!scope) return issues;
  return issues.filter((issue) =>
    issue.code === "check_script_failed"
    || issue.code === "active_vertical_resolution_failed"
    || issue.code === "harness_settings_invalid"
    || mentionsScope(issue.message, scope.matchTokens)
    || mentionsScope(issue.repairHint, scope.matchTokens)
  );
}

export function checkScopeReport(scope: ResolvedCheckScope): Record<string, unknown> {
  return {
    kind: scope.kind,
    value: scope.value,
    taskIds: [...scope.taskIds].sort(),
    paths: scope.paths
  };
}

export function summarizeValidatorIssues(
  issues: ReadonlyArray<ProfileValidationIssue>
): ReadonlyArray<{
  readonly source: string;
  readonly warningCount: number;
  readonly hardFailCount: number;
  readonly codes: ReadonlyArray<string>;
}> {
  const sources = [...new Set(issues.map((issue) => issue.source))].sort();
  return sources.map((source) => {
    const sourceIssues = issues.filter((issue) => issue.source === source);
    return {
      source,
      warningCount: sourceIssues.filter((issue) => issue.severity === "warning").length,
      hardFailCount: sourceIssues.filter((issue) => issue.severity === "hard-fail").length,
      codes: [...new Set(sourceIssues.map((issue) => issue.code))].sort()
    };
  });
}

function projectionWarningMatchesScope(warning: ProjectionWarning, scope: ResolvedCheckScope): boolean {
  if (warning.code === "projection_missing" || warning.code === "projection_stale" || warning.code === "projection_tampered") return true;
  return mentionsScope(warning.message, scope.matchTokens);
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function mentionsScope(text: string, tokens: ReadonlyArray<string>): boolean {
  return tokens.some((token) => text.indexOf(token) >= 0);
}
