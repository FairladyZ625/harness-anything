import path from "node:path";
import { Effect } from "effect";
import {
  checkTaskProjection,
  queryTaskProjection,
  queryTaskSubtree,
  readRelationGraphProjection,
  type TaskFieldExtensionProjection,
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { bundledVerticalDefinition } from "../extensions/bundled.ts";
import {
  buildTaskShowReport,
  filterRelations,
  relationFiltersForReport,
  renderTaskTreeRows,
  summarizeRelationRows,
  summarizeStatus
} from "./task-query-reports.ts";

type TaskQueryAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-list" | "task-show" | "relation-list" | "status" }>;

export const runTaskQueryCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskQueryAction;
  if (action.kind === "task-list") {
    return Effect.sync(() => {
      const result = queryTaskProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        filters: action.filters,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      return {
        ok: true,
        command: "task-list",
        tasks: result.rows,
        warnings: result.warnings
      } satisfies CliResult;
    });
  }
  if (action.kind === "task-show" && action.view === "summary") {
    return Effect.sync(() => {
      const result = queryTaskProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        filters: { includeArchived: true },
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const task = result.rows.find((row) => row.taskId === action.taskId);
      if (!task) {
        return {
          ok: false,
          command: "task-show",
          taskId: action.taskId,
          error: cliError(CliErrorCode.TaskNotFound, `task not found: ${action.taskId}`)
        } satisfies CliResult;
      }
      const graph = readRelationGraphProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const report = buildTaskShowReport(task, result.rows, graph.edges, graph.factAnchors);
      return {
        ok: true,
        command: "task-show",
        taskId: action.taskId,
        path: task.sourcePath,
        warnings: [...result.warnings, ...graph.warnings],
        report
      } satisfies CliResult;
    });
  }
  if (action.kind === "task-show" && action.view === "tree") {
    return Effect.sync(() => {
      const result = queryTaskSubtree({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        rootTaskId: action.taskId,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
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
  if (action.kind === "relation-list") {
    return Effect.sync(() => {
      const graph = readRelationGraphProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const relations = filterRelations(graph.edges, action.filters);
      return {
        ok: true,
        command: "relation-list",
        rows: relations.length,
        warnings: graph.warnings,
        report: {
          schema: "relation-list-report/v1",
          filters: relationFiltersForReport(action.filters),
          relations,
          summary: summarizeRelationRows(relations)
        }
      } satisfies CliResult;
    });
  }
  return Effect.sync(() => {
    const result = checkTaskProjection({
      rootDir: context.rootDir,
      layoutOverrides: context.layoutOverrides,
      postMerge: true,
      taskFieldExtensions: activeTaskFieldExtensions()
    });
    return {
      ok: result.ok,
      command: "status",
      rows: result.rows.length,
      warnings: result.warnings,
      report: result.report,
      summary: summarizeStatus(result.rows),
      commands: context.commandRegistry,
      projectionPath: path.relative(command.rootDir, result.projectionPath).split(path.sep).join("/"),
      error: result.ok ? undefined : cliError(CliErrorCode.StatusCheckFailed, "Harness status has warnings that require attention.")
    } satisfies CliResult;
  });
};

function activeTaskFieldExtensions(): ReadonlyArray<TaskFieldExtensionProjection> {
  return bundledVerticalDefinition()?.entityFieldExtensions ?? [];
}
