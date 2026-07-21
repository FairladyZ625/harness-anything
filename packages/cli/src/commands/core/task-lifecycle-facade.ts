import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { finalizeDryRunResult } from "../../cli/dry-run-preview.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../../cli/receipt.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { resolveGitCommitSha } from "./authored-git.ts";
import { guidedLifecycleFacadeFailure, shellLifecycleToken } from "./task-lifecycle-facade-guidance.ts";

type Dispatch = (step: ParsedCommand) => Promise<CommandReceipt | CommandFailureReceipt>;
type TaskStartCommand = ParsedCommand & { readonly action: Extract<ParsedCommand["action"], { readonly kind: "task-start" }> };
type TaskCloseoutCommand = ParsedCommand & { readonly action: Extract<ParsedCommand["action"], { readonly kind: "task-closeout" }> };

export async function runTaskStartFacade(command: ParsedCommand, dispatch: Dispatch): Promise<CommandReceipt | CommandFailureReceipt | CliResult> {
  if (command.action.kind !== "task-start") throw new Error("task start facade received a non-start command");
  const startCommand = command as TaskStartCommand;
  const steps = taskStartFacadeSteps(startCommand);
  if (command.action.dryRun) return dryRun(startCommand, steps);
  const receipts: CommandReceipt[] = [];
  for (const step of steps) {
    const receipt = await dispatch(step);
    if (!receipt.ok) return guidedLifecycleFacadeFailure(receipt, receipts, step, "task-start");
    receipts.push(receipt);
  }
  const claimData = lifecycleFacadeReceiptData(receipts[0]!);
  const claimReport = lifecycleFacadeRecord(claimData.report);
  return {
    ok: true,
    command: "task-start",
    taskId: command.action.taskId,
    executionId: text(claimData.executionId) ?? text(claimReport?.executionId),
    status: "active",
    report: {
      schema: "task-start-result/v1",
      executionId: text(claimData.executionId) ?? text(claimReport?.executionId),
      leaseToken: text(claimReport?.leaseToken),
      leaseExpiresAt: text(claimReport?.leaseExpiresAt),
      reused: claimReport?.reused === true,
      steps: receipts
    }
  } satisfies CliResult;
}

export async function runTaskCloseoutFacade(command: ParsedCommand, dispatch: Dispatch): Promise<CommandReceipt | CommandFailureReceipt | CliResult> {
  if (command.action.kind !== "task-closeout") throw new Error("task closeout facade received a non-closeout command");
  const closeoutCommand = command as TaskCloseoutCommand;
  const resolved = resolveCommit(command.rootDir, command.action.commitRef);
  if (!resolved.ok) return resolved.result;
  const steps = taskCloseoutFacadeSteps(closeoutCommand, resolved.sha);
  if (command.action.dryRun) return dryRun(closeoutCommand, steps, { commit: resolved.sha });
  const receipts: CommandReceipt[] = [];
  for (const step of steps) {
    const receipt = await dispatch(step);
    if (!receipt.ok) return guidedLifecycleFacadeFailure(receipt, receipts, step, "task-closeout");
    receipts.push(receipt);
  }
  const submitData = lifecycleFacadeReceiptData(receipts[0]!);
  return {
    ok: true,
    command: "task-closeout",
    taskId: command.action.taskId,
    executionId: text(submitData.executionId),
    status: "done",
    report: {
      schema: "task-closeout-result/v1",
      commit: resolved.sha,
      steps: receipts
    }
  } satisfies CliResult;
}

export function taskStartFacadeSteps(command: TaskStartCommand): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  return [
    child(command, {
      kind: "task-claim",
      taskId: action.taskId,
      execution: true,
      ...(action.executionId ? { executionId: action.executionId } : {}),
      ...(action.ttlMs === undefined ? {} : { ttlMs: action.ttlMs })
    }),
    child(command, { kind: "status-set", taskId: action.taskId, status: "active", force: false })
  ];
}

export function taskCloseoutFacadeSteps(command: TaskCloseoutCommand, sha: string): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  return [
    child(command, {
      kind: "status-set",
      taskId: action.taskId,
      status: "in_review",
      force: false,
      executionSubmission: {
        ...(action.executionId ? { executionId: action.executionId } : {}),
        ...(action.leaseToken ? { leaseToken: action.leaseToken } : {}),
        ...action.submission
      }
    }),
    child(command, { kind: "task-review-execution", taskId: action.taskId, ...action.review }),
    child(command, {
      kind: "task-code-doc-reconcile",
      taskId: action.taskId,
      sha,
      paths: action.paths,
      ...(action.prRef ? { prRef: action.prRef } : {}),
      force: action.forceCodeDoc
    }),
    child(command, {
      kind: "task-complete",
      taskId: action.taskId,
      ciGate: action.ciGate,
      reviewerId: action.reviewerId
    })
  ];
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

function child(command: ParsedCommand, action: ParsedCommand["action"]): ParsedCommand {
  return { ...command, action };
}

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

function resolveCommit(rootDir: string, commitRef: string): { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly result: CliResult } {
  try {
    const sha = resolveGitCommitSha(rootDir, commitRef);
    if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`git returned a non-40-character commit id: ${sha}`);
    return { ok: true, sha };
  } catch (error) {
    const next = `git -C ${shellLifecycleToken(rootDir)} rev-parse --verify ${shellLifecycleToken(`${commitRef}^{commit}`)}`;
    return {
      ok: false,
      result: {
        ok: false,
        command: "task-closeout",
        error: cliError(
          CliErrorCode.InvalidTaskMetadata,
          `Cannot resolve commit ref ${commitRef} to a full 40-character SHA: ${error instanceof Error ? error.message : String(error)}. Next: run \`${next}\`.`
        )
      }
    };
  }
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
