import path from "node:path";
import { Effect } from "effect";
import { checkTaskProjection, queryTaskProjection, queryTaskSubtree } from "../../../../kernel/src/index.ts";
import { commandRegistry } from "../../cli/command-registry.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type TaskQueryAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-list" | "task-tree" | "status" }>;

export const runTaskQueryCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskQueryAction;
  if (action.kind === "task-list") {
    return Effect.sync(() => {
      const result = queryTaskProjection({ rootDir: context.rootDir, layoutOverrides: context.layoutOverrides, filters: action.filters });
      return {
        ok: true,
        command: "task-list",
        tasks: result.rows,
        warnings: result.warnings
      } satisfies CliResult;
    });
  }
  if (action.kind === "task-tree") {
    return Effect.sync(() => {
      const result = queryTaskSubtree({ rootDir: context.rootDir, layoutOverrides: context.layoutOverrides, rootTaskId: action.taskId });
      const rows = result.rows;
      if (!rows.some((row) => row.taskId === action.taskId)) {
        return {
          ok: false,
          command: "task-tree",
          taskId: action.taskId,
          error: cliError(CliErrorCode.TaskNotFound, `task not found: ${action.taskId}`)
        } satisfies CliResult;
      }
      return {
        ok: true,
        command: "task-tree",
        taskId: action.taskId,
        tasks: renderTaskTreeRows(rows, action.taskId),
        warnings: result.warnings,
        report: { schema: "task-tree-report/v1", rootTaskId: action.taskId, nodeCount: rows.length }
      } satisfies CliResult;
    });
  }
  return Effect.sync(() => {
    const result = checkTaskProjection({ rootDir: context.rootDir, layoutOverrides: context.layoutOverrides, postMerge: true });
    return {
      ok: result.ok,
      command: "status",
      rows: result.rows.length,
      warnings: result.warnings,
      report: result.report,
      summary: summarizeStatus(result.rows),
      commands: commandRegistry,
      projectionPath: path.relative(command.rootDir, result.projectionPath).split(path.sep).join("/"),
      error: result.ok ? undefined : cliError(CliErrorCode.StatusCheckFailed, "Harness status has warnings that require attention.")
    } satisfies CliResult;
  });
};

function summarizeStatus(
  rows: ReadonlyArray<{ readonly packageDisposition: string; readonly coordinationStatus: string }>
): NonNullable<CliResult["summary"]> {
  return {
    taskCount: rows.length,
    byPackageDisposition: countBy(rows.map((row) => row.packageDisposition)),
    byCoordinationStatus: countBy(rows.map((row) => row.coordinationStatus))
  };
}

function renderTaskTreeRows(
  rows: ReadonlyArray<{ readonly taskId: string; readonly title: string; readonly parentTaskId?: string; readonly canonicalStatus: string }>,
  rootTaskId: string
): ReadonlyArray<{ readonly taskId: string; readonly title: string; readonly status: string; readonly parentTaskId?: string; readonly depth: number }> {
  const byParent = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.parentTaskId) continue;
    byParent.set(row.parentTaskId, [...(byParent.get(row.parentTaskId) ?? []), row].sort((a, b) => a.taskId.localeCompare(b.taskId)));
  }
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  const output: Array<{ readonly taskId: string; readonly title: string; readonly status: string; readonly parentTaskId?: string; readonly depth: number }> = [];
  const seen = new Set<string>();
  function visit(taskId: string, depth: number): void {
    if (seen.has(taskId)) return;
    const row = byId.get(taskId);
    if (!row) return;
    seen.add(taskId);
    output.push({
      taskId: row.taskId,
      title: row.title,
      status: row.canonicalStatus,
      ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
      depth
    });
    for (const child of byParent.get(taskId) ?? []) visit(child.taskId, depth + 1);
  }
  visit(rootTaskId, 0);
  return output;
}

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
