import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, MaterializerCommandReport, ParsedCommand } from "../../cli/types.ts";
import type { CommandRunnerContext, CommandRunnerEffect } from "../../cli/runner-registry.ts";

export function runMaterializerCommand(
  context: CommandRunnerContext,
  command: ParsedCommand
): CommandRunnerEffect {
  const action = command.action;
  if (action.kind !== "materializer-run") {
    return Effect.succeed({
      ok: false,
      command: action.kind,
      error: cliError(CliErrorCode.UnknownCommand, `Unsupported materializer command: ${action.kind}`)
    } satisfies CliResult);
  }
  return Effect.sync(() => materializerCommandResult(context.runLedgerMaterializer({ dryRun: action.dryRun })));
}

export function materializerCommandResult(report: MaterializerCommandReport): CliResult {
  return {
    ok: true,
    command: "materializer-run",
    rows: report.branches.length,
    warnings: report.warnings,
    report
  };
}
