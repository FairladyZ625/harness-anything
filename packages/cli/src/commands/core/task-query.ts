import path from "node:path";
import { Effect } from "effect";
import { checkTaskProjection, queryTaskProjection } from "../../../../kernel/src/index.ts";
import { commandRegistry } from "../../cli/command-registry.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type TaskQueryAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-list" | "status" }>;

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

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
