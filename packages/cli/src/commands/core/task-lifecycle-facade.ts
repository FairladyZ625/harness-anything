import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { finalizeDryRunResult } from "../../cli/dry-run-preview.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../../cli/receipt.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { inspectGitCommitRef } from "./authored-git.ts";
import { resolveTaskDocSyncPaths } from "./doc-sync.ts";
import {
  taskCompleteApprovalPreflightIssues,
  taskCompleteCodeDocAlreadyCurrent,
  taskCompleteFacadeSteps,
  type TaskCompleteCommand
} from "./task-complete-facade-steps.ts";
import {
  taskCompleteDryRunResult,
  taskCompletePreflightCompletionGate,
  taskCompletePreflightFailure,
  taskCompletePreflightReport,
  taskCompletePreflightReviewAlreadyReady,
  taskCompletePreflightStep
} from "./task-complete-preflight.ts";
import { dispatchLifecycleFacadeSteps, shellLifecycleToken } from "./task-lifecycle-facade-guidance.ts";
import {
  resolveFacadeCommandRoot,
  taskStartFacadeSteps,
  type TaskStartCommand
} from "./task-lifecycle-facade-steps.ts";
export {
  isCodeDocReconciliationCurrent,
  taskCompleteFacadeSteps
} from "./task-complete-facade-steps.ts";
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
  const layoutInput = { rootDir: closeoutCommand.rootDir, layoutOverrides: closeoutCommand.layoutOverrides };
  const docPaths = resolveTaskDocSyncPaths(layoutInput, closeoutCommand.action.taskId, "task-closeout");
  if (!docPaths.ok) return docPaths.result;
  const steps = taskCloseoutFacadeSteps(closeoutCommand, resolved.sha, docPaths.paths);
  if (command.action.dryRun) return dryRun(closeoutCommand, steps, { commit: resolved.sha });
  const dispatched = await dispatchLifecycleFacadeSteps(steps, dispatch, "task-closeout");
  if (!dispatched.ok) return dispatched.receipt;
  const { receipts, warnings } = dispatched;
  const submitData = lifecycleFacadeReceiptData(receipts[0]!);
  return {
    ok: true,
    command: "task-closeout",
    taskId: command.action.taskId,
    executionId: text(submitData.executionId),
    status: "done",
    ...(warnings.length > 0 ? { warnings } : {}),
    report: {
      schema: "task-closeout-result/v1",
      commit: resolved.sha,
      steps: receipts
    }
  } satisfies CliResult;
}

export async function runTaskCompleteFacade(command: ParsedCommand, dispatch: Dispatch): Promise<CommandReceipt | CommandFailureReceipt | CliResult> {
  if (command.action.kind !== "task-complete") throw new Error("task complete facade received a non-complete command");
  const completeCommand = resolveFacadeCommandRoot(command) as TaskCompleteCommand;
  const preflightReceipt = await dispatch(taskCompletePreflightStep(completeCommand));
  const resolved = resolveCommit(completeCommand.rootDir, completeCommand.action.commitRef ?? "HEAD", "task-complete");
  const layoutInput = { rootDir: completeCommand.rootDir, layoutOverrides: completeCommand.layoutOverrides };
  const docPaths = resolveTaskDocSyncPaths(layoutInput, completeCommand.action.taskId, "task-complete");
  const reviewAlreadyReady = taskCompletePreflightReviewAlreadyReady(preflightReceipt);
  const approvalPreflightIssues = reviewAlreadyReady
    ? []
    : await taskCompleteApprovalPreflightIssues(completeCommand);
  const codeDocAlreadyCurrent = resolved.ok && docPaths.ok && docPaths.paths.length === 0
    ? await taskCompleteCodeDocAlreadyCurrent(completeCommand, resolved.sha)
    : false;
  const preflight = taskCompletePreflightReport({
    command: completeCommand,
    receipt: preflightReceipt,
    commit: resolved,
    docPaths,
    additionalIssues: approvalPreflightIssues
  });
  const steps = resolved.ok && docPaths.ok
    ? taskCompleteFacadeSteps(
        completeCommand,
        resolved.sha,
        docPaths.paths,
        { codeDocAlreadyCurrent, reviewAlreadyReady }
      )
    : [];
  const completionGate = taskCompletePreflightCompletionGate(preflightReceipt);
  if (completeCommand.action.dryRun) return taskCompleteDryRunResult(completeCommand, steps, {
    commit: resolved.ok ? resolved.sha : null,
    codeDocReconciliation: resolved.ok
      ? codeDocAlreadyCurrent ? "already-current" : "reconcile-required"
      : "commit-unresolved",
    preflight,
    completionGate
  });
  if (preflight.status === "blocked") return taskCompletePreflightFailure(completeCommand, preflight, completionGate);
  if (!resolved.ok) return resolved.result;
  if (!docPaths.ok) return docPaths.result;
  const dispatched = await dispatchLifecycleFacadeSteps(steps, dispatch, "task-complete");
  if (!dispatched.ok) return dispatched.receipt;
  const { receipts, warnings } = dispatched;
  const completed = receipts.at(-1)!;
  return {
    ...completed,
    ...((completed.warnings?.length ?? 0) + warnings.length > 0
      ? { warnings: [...(completed.warnings ?? []), ...warnings] }
      : {}),
    details: {
      ...completed.details,
      data: {
        ...(lifecycleFacadeRecord(completed.details?.data) ?? {}),
        report: {
          schema: "task-complete-result/v1",
          commit: resolved.sha,
          codeDocReconciliation: codeDocAlreadyCurrent
            ? { status: "already-current", skippedWrite: true }
            : { status: "reconciled", skippedWrite: false },
          steps: receipts
        }
      }
    }
  };
}

export function taskCloseoutFacadeSteps(
  command: TaskCloseoutCommand,
  sha: string,
  docSyncPaths: ReadonlyArray<string> = []
): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  return taskCompleteFacadeSteps({
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
  }, sha, docSyncPaths);
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
  command: TaskStartCommand | TaskCloseoutCommand | TaskCompleteCommand,
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
