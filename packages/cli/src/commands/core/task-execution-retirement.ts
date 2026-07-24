import { makeExecutionRetirementService } from "@harness-anything/application";
import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult } from "../../cli/types.ts";

type ExecutionRetirementAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "task-retire-execution" }
>;

export const runTaskRetireExecution: CommandRunner = (context, command) => {
  const action = command.action as ExecutionRetirementAction;
  return executeRetirement(context, action);
};

function executeRetirement(
  context: CommandRunnerContext,
  action: ExecutionRetirementAction
): Effect.Effect<CliResult> {
  const service = makeExecutionRetirementService({
    rootInput: context.layoutInput,
    coordinator: context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-retirement" }),
    artifactStore: context.artifactStore,
    taskHolderService: context.taskHolderService
  });
  return Effect.tryPromise({
    try: () => service.retireStaleExecution({
      taskId: action.taskId,
      executionId: action.executionId,
      reason: action.reason,
      retiredAt: action.retiredAt,
      actor: context.taskHolderPrincipal()
    }),
    catch: (error) => error
  }).pipe(Effect.match({
    onFailure: (error): CliResult => ({
      ok: false,
      command: action.kind,
      taskId: action.taskId,
      executionId: action.executionId,
      error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
    }),
    onSuccess: (result): CliResult => ({
      ok: true,
      command: action.kind,
      taskId: action.taskId,
      executionId: action.executionId,
      path: result.auditPath,
      report: {
        schema: "execution-retirement-result/v1",
        ...result
      }
    })
  }));
}
