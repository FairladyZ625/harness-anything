import { Effect } from "effect";
import type { FactWriteRejected } from "../../../../application/src/index.ts";
import type { WriteError } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type FactAction = Extract<ParsedCommand["action"], { readonly kind: "record-fact" }>;

export const runFactCommand: CommandRunner = (context, command) => {
  const action = command.action as FactAction;
  return context.factWriteService.record({
    ownerTaskId: action.taskId,
    factId: action.factId,
    statement: action.statement,
    source: action.source,
    observedAt: action.observedAt,
    confidence: action.confidence,
    memoryClass: action.memoryClass,
    memoryTags: action.memoryTags,
    dryRun: action.dryRun
  }).pipe(
    Effect.match({
      onFailure: (error): CliResult => factFailure(action, error),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "record-fact",
        taskId: result.taskId,
        factId: result.factId,
        factRef: result.ref,
        path: result.path,
        report: {
          schema: "fact-record-cli-report/v1",
          dryRun: action.dryRun,
          ref: result.ref
        }
      })
    })
  );
};

function factFailure(action: FactAction, error: FactWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "FactWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command: "record-fact",
    taskId: action.taskId,
    error: cliError(CliErrorCode.FactWriteRejected, reason)
  };
}
