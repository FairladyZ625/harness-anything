import { cliError, CliErrorCode, isCliErrorCode } from "../../cli/error-codes.ts";
import { finalizeDryRunResult } from "../../cli/dry-run-preview.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../../cli/receipt.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import type { TaskCompleteCommand } from "./task-complete-facade-steps.ts";

export interface TaskCompletePreflightIssue {
  readonly code: string;
  readonly gateCode?: string;
  readonly message: string;
  readonly nextCommand: string;
  readonly disposition: "blocked" | "planned";
}

export interface TaskCompletePreflightReport {
  readonly schema: "task-complete-preflight/v1";
  readonly status: "ready" | "blocked";
  readonly issues: ReadonlyArray<TaskCompletePreflightIssue>;
}

export type TaskCompleteCommitResolution =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly result: CliResult };

export type TaskCompleteDocPathsResolution =
  | { readonly ok: true; readonly paths: ReadonlyArray<string> }
  | { readonly ok: false; readonly result: CliResult };

export function taskCompletePreflightStep(command: TaskCompleteCommand): ParsedCommand {
  const action = command.action;
  return {
    ...command,
    action: {
      kind: "task-complete",
      taskId: action.taskId,
      ...(action.approval?.executionId ? { executionId: action.approval.executionId } : {}),
      ciGate: action.ciGate,
      reviewerId: action.reviewerId,
      evidenceMode: action.evidenceMode,
      ...(action.commitRef ? { commitRef: action.commitRef } : {}),
      ...(action.judgment !== undefined ? { judgment: action.judgment } : {}),
      dryRun: true
    }
  };
}

export function taskCompletePreflightReport(input: {
  readonly command: TaskCompleteCommand;
  readonly receipt: CommandReceipt | CommandFailureReceipt;
  readonly commit: TaskCompleteCommitResolution;
  readonly docPaths: TaskCompleteDocPathsResolution;
  readonly additionalIssues?: ReadonlyArray<TaskCompletePreflightIssue>;
}): TaskCompletePreflightReport {
  const data = preflightRecord(input.receipt.details?.data) ?? {};
  const rawIssues = Array.isArray(data.issues) ? data.issues : [];
  const issues = rawIssues.flatMap((raw): TaskCompletePreflightIssue[] => {
    const issue = preflightRecord(raw);
    if (!issue) return [];
    const code = typeof issue.code === "string" ? issue.code : undefined;
    const message = typeof issue.message === "string" ? issue.message : undefined;
    if (!code || !message) return [];
    return [{
      code,
      ...(typeof issue.gateCode === "string" ? { gateCode: issue.gateCode } : {}),
      message,
      nextCommand: issueNextCommand(input.command.action.taskId, code, issue.nextCommand),
      disposition: plannedByFacade(code, input.command, input.commit.ok, input.docPaths.ok)
        ? "planned"
        : "blocked"
    }];
  });
  if (!input.receipt.ok && issues.length === 0) {
    issues.push({
      code: input.receipt.error?.code ?? "write_rejected",
      message: input.receipt.error?.hint ?? input.receipt.summary,
      nextCommand: input.receipt.next?.[0]?.command ?? taskShowCommand(input.command.action.taskId),
      disposition: "blocked"
    });
  }
  if (!input.commit.ok) issues.unshift(cliResultIssue(input.commit.result, input.command.action.taskId));
  if (!input.docPaths.ok) issues.push(cliResultIssue(input.docPaths.result, input.command.action.taskId));
  issues.push(...(input.additionalIssues ?? []));
  const deduplicated = issues.filter((issue, index) => issues.findIndex((candidate) => candidate.code === issue.code) === index);
  return {
    schema: "task-complete-preflight/v1",
    status: deduplicated.some((issue) => issue.disposition === "blocked") ? "blocked" : "ready",
    issues: deduplicated
  };
}

export function taskCompletePreflightCompletionGate(receipt: CommandReceipt | CommandFailureReceipt): unknown {
  return preflightRecord(receipt.details?.data)?.completionGate ?? { ok: false, issues: [] };
}

export function taskCompletePreflightReviewAlreadyReady(
  receipt: CommandReceipt | CommandFailureReceipt
): boolean {
  const data = preflightRecord(receipt.details?.data);
  const completionGate = preflightRecord(data?.completionGate);
  if (!preflightRecord(completionGate?.axes)) return false;
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return !issues.some((raw) => {
    const code = preflightRecord(raw)?.code;
    return typeof code === "string" && (
      code.startsWith("execution_")
      || code === "archive_warnings_acknowledgement_required"
    );
  });
}

export function taskCompleteDryRunResult(
  command: TaskCompleteCommand,
  steps: ReadonlyArray<ParsedCommand>,
  extra: Readonly<Record<string, unknown>> & {
    readonly completionGate: unknown;
    readonly preflight: TaskCompletePreflightReport;
  }
): CliResult {
  const status = completionGateTaskStatus(extra.completionGate);
  if (!status) return taskCompletePreflightFailure(command, extra.preflight, extra.completionGate);
  return finalizeDryRunResult(command.action, {
    ok: true,
    command: command.action.kind,
    taskId: command.action.taskId,
    status,
    completionGate: extra.completionGate,
    report: {
      schema: "task-complete-dry-run/v1",
      dryRun: true,
      ...extra,
      steps: steps.map((step) => step.action.kind)
    }
  } satisfies CliResult);
}

export function taskCompletePreflightFailure(
  command: TaskCompleteCommand,
  preflight: TaskCompletePreflightReport,
  completionGate: unknown
): CliResult {
  const blocked = preflight.issues.filter((issue) => issue.disposition === "blocked");
  const hint = `Task completion preflight found ${blocked.length} blocking requirement${blocked.length === 1 ? "" : "s"}: ${blocked.map((issue) => `[${issue.code}] ${issue.message} Next: ${issue.nextCommand}`).join(" | ")}`;
  const code = blocked[0]?.code;
  return {
    ok: false,
    command: "task-complete",
    taskId: command.action.taskId,
    issues: preflight.issues,
    completionGate,
    report: { schema: "task-complete-preflight/v1", preflight },
    error: cliError(code && isCliErrorCode(code) ? code : CliErrorCode.WriteRejected, hint)
  } satisfies CliResult;
}

function plannedByFacade(
  code: string,
  command: TaskCompleteCommand,
  commitResolved: boolean,
  docPathsResolved: boolean
): boolean {
  if (code.startsWith("code_doc_") && commitResolved && docPathsResolved) return true;
  if (code === "execution_review_required" && command.action.approval !== undefined) return true;
  return code === "archive_warnings_acknowledgement_required"
    && command.action.approval?.archiveWarningsAcknowledged === true;
}

function issueNextCommand(taskId: string, code: string, value: unknown): string {
  if (code === "closeout_placeholder") return "ha doc sync --submit --path <task-closeout-path>";
  if (typeof value === "string" && value.trim()) return value;
  return taskShowCommand(taskId);
}

function cliResultIssue(result: CliResult, taskId: string): TaskCompletePreflightIssue {
  const hint = result.error?.hint ?? "Task completion preflight failed.";
  return {
    code: result.error?.code ?? "write_rejected",
    message: hint,
    nextCommand: hint.match(/Next: run `([^`]+)`/u)?.[1] ?? taskShowCommand(taskId),
    disposition: "blocked"
  };
}

function taskShowCommand(taskId: string): string {
  return `ha task show ${taskId} --view summary --json`;
}

function preflightRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function completionGateTaskStatus(value: unknown): CliResult["status"] | undefined {
  const status = preflightRecord(preflightRecord(value)?.axes)?.coordinationStatus;
  return typeof status === "string" && ["planned", "active", "blocked", "in_review", "done", "cancelled"].includes(status)
    ? status as CliResult["status"]
    : undefined;
}
