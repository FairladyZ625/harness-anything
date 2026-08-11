import path from "node:path";
import { Effect } from "effect";
import {
  checkTaskProjection,
  queryTaskProjection,
  readRelationGraphProjection,
  type TaskFieldExtensionProjection,
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { bundledVerticalDefinition } from "../extensions/bundled.ts";
import {
  filterRelations,
  relationFiltersForReport,
  summarizeRelationRows,
  summarizeStatus
} from "./task-query-reports.ts";

type TaskQueryAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-list" | "relation-list" | "status" }>;

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
