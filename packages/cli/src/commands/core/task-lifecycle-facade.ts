import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { finalizeDryRunResult } from "../../cli/dry-run-preview.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../../cli/receipt.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { inspectGitCommitRef } from "./authored-git.ts";
import { shellLifecycleToken } from "./task-lifecycle-facade-guidance.ts";
import {
  resolveFacadeCommandRoot,
  taskStartFacadeSteps,
  type TaskStartCommand
} from "./task-lifecycle-facade-steps.ts";
export { taskStartFacadeSteps } from "./task-lifecycle-facade-steps.ts";

type Dispatch = (step: ParsedCommand) => Promise<CommandReceipt | CommandFailureReceipt>;
type TaskCloseoutCommand = ParsedCommand & { readonly action: Extract<ParsedCommand["action"], { readonly kind: "task-closeout" }> };

export async function runTaskStartFacade(command: ParsedCommand, dispatch: Dispatch): Promise<CommandReceipt | CommandFailureReceipt | CliResult> {
  if (command.action.kind !== "task-start") throw new Error("task start facade received a non-start command");
  const startCommand = command as TaskStartCommand;
  const steps = taskStartFacadeSteps(startCommand);
  if (command.action.dryRun) return dryRun(startCommand, steps);
  return dispatch(steps[0]!);
}

export async function runTaskCloseoutFacade(command: ParsedCommand, dispatch: Dispatch): Promise<CommandReceipt | CommandFailureReceipt | CliResult> {
  if (command.action.kind !== "task-closeout") throw new Error("task closeout facade received a non-closeout command");
  const closeoutCommand = resolveFacadeCommandRoot(command) as TaskCloseoutCommand;
  const resolved = resolveCommit(closeoutCommand.rootDir, closeoutCommand.action.commitRef);
  if (!resolved.ok) return resolved.result;
  const steps = taskCloseoutFacadeSteps(closeoutCommand, resolved.sha);
  if (command.action.dryRun) return dryRun(closeoutCommand, steps, { commit: resolved.sha });
  const receipt = await dispatch(steps[0]!);
  if (!receipt.ok) return receipt;
  const submitData = lifecycleFacadeReceiptData(receipt);
  return {
    ok: true,
    command: "task-closeout",
    taskId: command.action.taskId,
    executionId: text(submitData.executionId),
    status: "done",
    ...(receipt.warnings && receipt.warnings.length > 0 ? { warnings: receipt.warnings } : {}),
    report: {
      schema: "task-closeout-result/v1",
      commit: resolved.sha,
      steps: [receipt]
    }
  } satisfies CliResult;
}

export function taskCloseoutFacadeSteps(
  command: TaskCloseoutCommand,
  sha: string,
  _docSyncPaths: ReadonlyArray<string> = []
): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  return [{
    ...command,
    action: {
      kind: "task-complete",
      taskId: action.taskId,
      ciGate: action.ciGate,
      reviewerId: action.reviewerId,
      evidenceMode: "execution-review",
      commitRef: sha,
      approval: {
        ...(action.review.executionId ? { executionId: action.review.executionId } : {}),
        findings: action.review.findings,
        evidenceChecked: action.review.evidenceChecked,
        rationale: action.review.rationale,
        archiveWarningsAcknowledged: action.review.archiveWarningsAcknowledged,
        ...(action.review.consentId ? { consentId: action.review.consentId } : {}),
        ...(action.review.consentUtterance ? { consentUtterance: action.review.consentUtterance } : {}),
        ...(action.review.consentStandingPolicyDecisionId ? { consentStandingPolicyDecisionId: action.review.consentStandingPolicyDecisionId } : {}),
        ...(action.review.consentAssertedRationale ? { consentAssertedRationale: action.review.consentAssertedRationale } : {}),
        ...(action.review.consentActions ? { consentActions: action.review.consentActions } : {}),
        paths: action.paths,
        ...(action.prRef ? { prRef: action.prRef } : {})
      }
    }
  }];
}

export const rejectDaemonTaskLifecycleFacade: CommandRunner = (_context, command) => Effect.succeed({
  ok: false,
  command: command.action.kind,
  taskId: "taskId" in command.action ? command.action.taskId : undefined,
  error: cliError(
    CliErrorCode.WriteRejected,
    `${command.action.kind === "task-start" ? "task start" : "task closeout"} is a CLI composition facade. Run the same ha command so every underlying lifecycle gate enters daemon admission independently.`
  )
} satisfies CliResult);

function dryRun(
  command: TaskStartCommand | TaskCloseoutCommand,
  steps: ReadonlyArray<ParsedCommand>,
  extra: Readonly<Record<string, unknown>> = {}
): CliResult {
  return finalizeDryRunResult(command.action, {
    ok: true,
    command: command.action.kind,
    taskId: command.action.taskId,
    report: {
      schema: `${command.action.kind}-dry-run/v1`,
      dryRun: true,
      ...extra,
      steps: steps.map((step) => step.action.kind)
    }
  } satisfies CliResult);
}

function resolveCommit(rootDir: string, commitRef: string, command = "task-closeout"):
  { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly result: CliResult } {
  const resolved = inspectGitCommitRef(rootDir, commitRef);
  if (resolved.ok && /^[0-9a-f]{40}$/u.test(resolved.sha)) return resolved;
  const next = `git -C ${shellLifecycleToken(rootDir)} rev-parse --verify ${shellLifecycleToken(`${commitRef}^{commit}`)}`;
  const code = command === "task-complete"
    ? resolved.ok || resolved.reason === "missing"
      ? CliErrorCode.CommitCompletionGitRefMissing
      : CliErrorCode.CommitCompletionNonCommitObject
    : CliErrorCode.InvalidTaskMetadata;
  const detail = resolved.ok
    ? `git returned a non-40-character commit id: ${resolved.sha}`
    : resolved.reason === "non-commit"
      ? `Git object type is ${resolved.objectType ?? "non-commit"}`
      : resolved.cause;
  return {
    ok: false,
    result: {
      ok: false,
      command,
      error: cliError(
        code,
        `Cannot resolve commit ref ${commitRef} to a full 40-character commit SHA: ${detail}. Next: run \`${next}\`.`
      )
    }
  };
}

function lifecycleFacadeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function lifecycleFacadeReceiptData(receipt: CommandReceipt): Record<string, unknown> {
  return lifecycleFacadeRecord(receipt.details?.data) ?? {};
}
