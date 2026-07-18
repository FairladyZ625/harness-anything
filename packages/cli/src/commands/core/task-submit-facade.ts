import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { finalizeDryRunResult } from "../../cli/dry-run-preview.ts";
import type { CliResult } from "../../cli/types.ts";
import type { ParsedCommand } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../../cli/receipt.ts";

type TaskSubmitCommand = ParsedCommand & {
  readonly action: Extract<ParsedCommand["action"], { readonly kind: "task-submit" }>;
};

export async function runTaskSubmitFacade(
  command: ParsedCommand,
  dispatch: (step: ParsedCommand) => Promise<CommandReceipt | CommandFailureReceipt>
): Promise<CommandReceipt | CommandFailureReceipt | CliResult> {
  if (command.action.kind !== "task-submit") throw new Error("task submit facade received a non-submit command");
  const steps = taskSubmitFacadeSteps(command as TaskSubmitCommand);
  if (command.action.dryRun) {
    return finalizeDryRunResult(command.action, {
      ok: true,
      command: "task-submit",
      taskId: command.action.taskId,
      report: {
        schema: "task-submit-dry-run/v1",
        steps: steps.map((step) => step.action.kind)
      }
    } satisfies CliResult);
  }
  let receipt: CommandReceipt | CommandFailureReceipt | undefined;
  const receipts: CommandReceipt[] = [];
  for (const step of steps) {
    receipt = await dispatch(step);
    if (!receipt.ok) return receipts.length === 0 ? receipt : {
      ...receipt,
      details: {
        ...receipt.details,
        data: {
          ...(receipt.details?.data && typeof receipt.details.data === "object" && !Array.isArray(receipt.details.data)
            ? receipt.details.data
            : {}),
          facade: {
            schema: "task-submit-partial-failure/v1",
            completedSteps: receipts,
            failedStep: receipt
          }
        }
      }
    };
    receipts.push(receipt);
  }
  return {
    ok: true,
    command: "task-submit",
    taskId: command.action.taskId,
    report: {
      schema: "task-submit-result/v1",
      steps: receipts
    }
  } satisfies CliResult;
}

export function taskSubmitFacadeSteps(command: TaskSubmitCommand): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  return [
    ...(action.codeDoc ? [{
      ...command,
      action: {
        kind: "task-code-doc-reconcile" as const,
        taskId: action.taskId,
        sha: action.codeDoc.sha,
        paths: action.codeDoc.paths,
        prRef: action.codeDoc.prRef,
        force: action.codeDoc.force
      }
    }] : []),
    {
      ...command,
      action: {
        kind: "status-set" as const,
        taskId: action.taskId,
        status: "in_review" as const,
        force: false,
        reason: undefined,
        executionSubmission: {
          ...(action.executionId ? { executionId: action.executionId } : {}),
          ...(action.leaseToken ? { leaseToken: action.leaseToken } : {}),
          ...action.submission
        }
      }
    }
  ];
}

export const rejectDaemonTaskSubmitFacade: CommandRunner = (_context, command) => Effect.succeed({
  ok: false,
  command: "task-submit",
  taskId: "taskId" in command.action ? command.action.taskId : undefined,
  error: cliError(
    CliErrorCode.WriteRejected,
    "task submit is a CLI composition facade. Run it through `ha task submit <id> --from-file <submission.json>` so each underlying command enters canonical admission independently."
  )
} satisfies CliResult);
