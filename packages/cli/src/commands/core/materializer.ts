import { Effect } from "effect";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { shellArgument } from "../../cli/shell-argument.ts";
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
  return Effect.sync(() => materializerCommandResult(
    context.runLedgerMaterializer({ dryRun: action.dryRun }),
    context.layoutInput
  ));
}

export function materializerCommandResult(report: MaterializerCommandReport, rootInput: HarnessLayoutInput): CliResult {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  const failures = report.branches.filter((branch) => branch.status === "conflict");
  const operationalFailures = failures.length === 0 ? report.warnings.map(String) : [];
  const failureLabels = [
    ...failures.map((branch) => branch.branch),
    ...operationalFailures
  ];
  const nextCommand = failures.find((branch) => branch.nextCommand)?.nextCommand
    ?? operationalFailures.map((message) => nextCommandForOperationalFailure(message, authoredRoot)).find(Boolean);
  const summary = `Materializer merged ${report.merged} branch${report.merged === 1 ? "" : "es"}; failed ${failureLabels.length}${failureLabels.length > 0 ? `: ${failureLabels.join(", ")}` : ""}.${nextCommand ? ` Next: ${nextCommand}` : ""}`;
  const warnings = failures.length > 0
    ? failures.map((branch) => ({
      severity: "error",
      code: "materializer_merge_failed",
      message: branch.warning ?? `${branch.branch}: merge failed`,
      branch: branch.branch,
      ...(branch.nextCommand ? { nextCommand: branch.nextCommand } : {})
    }))
    : operationalFailures.map((message) => ({
      severity: "error",
      code: "materializer_operational_failure",
      message,
      nextCommand: nextCommandForOperationalFailure(message, authoredRoot)
    }));
  return {
    ok: failureLabels.length === 0,
    command: "materializer-run",
    rows: report.dryRun
      ? report.branches.filter((branch) => branch.status === "would_merge").length
      : report.merged,
    warnings,
    report,
    ...(failureLabels.length > 0
      ? { error: cliError(CliErrorCode.WriteConflict, summary) }
      : {})
  };
}

function nextCommandForOperationalFailure(message: string, authoredRoot: string): string {
  if (message === "authored root is not a Git repository") return "ha init --json";
  if (/^trunk branch .+ does not exist$/u.test(message)) return `git -C ${shellArgument(authoredRoot)} branch --list`;
  return "ha status --json";
}
