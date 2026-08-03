import { Effect } from "effect";
import type { WriteError } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { toCliError } from "../../cli/error-mapper.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { taskSubmitTransitionCommandFromCliAction } from "../../cli/task-submit-transition-command.ts";
import { commandExecutionSaga } from "./task-holder-execution-saga.ts";
import { executionSubmitSuccessResult } from "./task-holder-submit-result.ts";
import { taskHolderPrincipal } from "./task-holder-support.ts";

export const runTaskSubmitCommand: CommandRunner = (context, command) => runExecutionSubmit(
  context,
  taskSubmitTransitionCommandFromCliAction(command.action)
);

function runExecutionSubmit(
  context: CommandRunnerContext,
  action: ReturnType<typeof taskSubmitTransitionCommandFromCliAction>
): Effect.Effect<CliResult> {
  if (action.dryRun) {
    return Effect.succeed({
      ok: true,
      command: "task-submit",
      taskId: action.taskId,
      ...(action.executionId ? { executionId: action.executionId } : {}),
      status: "in_review",
      report: {
        schema: "task-submit-transition-preview/v1",
        dryRun: true,
        disposition: "server-planner-validation-required"
      }
    } satisfies CliResult);
  }
  if (!context.authorityCommandSubmission) {
    return Effect.succeed({
      ok: false,
      command: "task-submit",
      taskId: action.taskId,
      error: cliError(
        CliErrorCode.WriteRejected,
        "Task submission requires the daemon-planned canonical transition submission; direct recovery cannot recreate that authority."
      )
    } satisfies CliResult);
  }
  const principal = taskHolderPrincipal(context);
  if (!principal.ok) return Effect.succeed(principal.result);
  const { authoredStore, saga } = commandExecutionSaga(context);
  const submission = action.submission;
  return Effect.gen(function* () {
    const executionId = action.executionId ?? undefined;
    if (!executionId) {
      return {
        ok: false,
        command: "task-submit",
        taskId: action.taskId,
        error: cliError(CliErrorCode.WriteRejected, `Execution submit requires an active Holder V2 execution. Next: run \`ha task start ${action.taskId}\`, then retry the same submit packet; use an explicit executionId only to select an existing active round.`)
      } satisfies CliResult;
    }
    const submitted = yield* Effect.tryPromise({
      try: () => saga.submitForReview({
        taskId: action.taskId,
        executionId,
        leaseToken: action.leaseToken ?? undefined,
        principal: principal.value,
        submission: {
          completionClaim: submission.completionClaim,
          deliverables: submission.deliverables,
          verificationNotes: submission.verificationNotes,
          knownGaps: submission.knownGaps,
          residualRisks: submission.residualRisks,
          evidence: submission.outputs.map((text, index) => ({
            evidence_id: `ev_cli_${index + 1}`,
            execution_ref: `execution/${action.taskId}/${executionId}`,
            locator: { substrate: "inline" as const, text }
          }))
        }
      }),
      catch: (error) => error
    }).pipe(Effect.match({
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: (result) => ({ ok: true as const, result })
    }));
    if (!submitted.ok) {
      return {
        ok: false,
        command: "task-submit",
        taskId: action.taskId,
        executionId,
        status: "in_review",
        error: isTaskHolderWriteError(submitted.error)
          ? toCliError(submitted.error)
          : cliError(CliErrorCode.WriteRejected, submitted.error instanceof Error ? submitted.error.message : String(submitted.error))
      } satisfies CliResult;
    }
    const submittedExecution = yield* Effect.promise(() => authoredStore.readExecution({
      taskId: action.taskId,
      executionId
    }));
    const unavailableBindings = submittedExecution?.session_bindings
      .filter((binding) => binding.archive_status === "unavailable")
      .map((binding) => ({
        bindingId: binding.binding_id,
        sessionRef: binding.session_ref,
        archiveStatus: binding.archive_status
      })) ?? [];
    return executionSubmitSuccessResult({
      taskId: action.taskId,
      executionId,
      leaseReleased: submitted.result.leaseReleased,
      cleanup: submitted.result.cleanup,
      unavailableBindings
    });
  });
}

function isTaskHolderWriteError(error: unknown): error is WriteError {
  return typeof error === "object" && error !== null && "_tag" in error && [
    "WriteRejected", "WriteConflict", "GlobalWriteConflict", "JournalUnavailable"
  ].includes(String(error._tag));
}
