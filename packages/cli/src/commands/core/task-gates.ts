import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { evaluateCompletionGate, evaluateReviewGate, parseReviewMarkdown } from "../../../../application/src/index.ts";
import { taskDocumentPath } from "../../../../kernel/src/layout/index.ts";
import { readTaskProjection } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode, type CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";

type TaskGateAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-review" | "task-complete" }>;

export const runTaskGatesCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskGateAction;
  if (action.kind === "task-review") {
    return Effect.sync(() => runTaskReview(context, action.taskId, action.reviewerId));
  }
  return Effect.gen(function* () {
    const gate = runTaskComplete(context, action.taskId, action.reviewerId, action.ciGate);
    if (!gate.ok) return gate;
    const result = yield* context.engine.setStatus({ taskId: action.taskId, status: "done" });
    return { ...gate, status: result.status } satisfies CliResult;
  });
};

function runTaskReview(context: CommandRunnerContext, taskId: string, reviewerId: string): CliResult {
  const reviewPath = taskDocumentPath(context.layoutInput, taskId, "review.md");
  if (!existsSync(reviewPath)) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      error: cliError(CliErrorCode.ReviewDocumentMissing, "Task review requires review.md in the task package.")
    };
  }

  const parsed = parseReviewMarkdown(readFileSync(reviewPath, "utf8"));
  if (parsed.issues.length > 0) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      issues: parsed.issues,
      error: cliError(CliErrorCode.ReviewSchemaInvalid, "review.md material findings table failed validation.")
    };
  }

  const gate = evaluateReviewGate({
    taskId,
    reviewerId,
    submittedAt: new Date().toISOString(),
    findings: parsed.findings
  });
  if (!gate.ok) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      report: gate,
      issues: gate.issues,
      error: cliError(CliErrorCode.ReleaseBlockingFindings, "Open release-blocking findings must be closed before review passes.")
    };
  }

  return { ok: true, command: "task-review", taskId, report: gate, reviewContract: gate.contract };
}

function runTaskComplete(context: CommandRunnerContext, taskId: string, reviewerId: string, ciGate: "passed" | "failed"): CliResult {
  const review = runTaskReview(context, taskId, reviewerId);
  if (!review.ok) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      report: review.report,
      issues: review.issues,
      error: cliError(CliErrorCode.ReviewNotPassed, "Task completion requires a passed task-review gate.")
    };
  }

  const projection = readTaskProjection({ rootDir: context.rootDir, layoutOverrides: context.layoutOverrides });
  const row = projection.rows.find((item) => item.taskId === taskId);
  if (!row) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      error: cliError(CliErrorCode.TaskNotFound, `task not found: ${taskId}`)
    };
  }

  const completionGate = evaluateCompletionGate({
    taskId,
    coordinationStatus: row.coordinationStatus,
    packageDisposition: row.packageDisposition,
    closeoutReadiness: row.closeoutReadiness,
    reviewGate: "passed",
    ciGate
  });
  if (!completionGate.ok) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      completionGate,
      issues: completionGate.issues,
      error: cliError(completionGateErrorCode(completionGate.issues), "Task completion gate failed.")
    };
  }

  return { ok: true, command: "task-complete", taskId, completionGate, reviewContract: review.reviewContract };
}

function completionGateErrorCode(issues: ReadonlyArray<{ readonly code: string }>): CliErrorCodeValue {
  const code = issues[0]?.code;
  return isCliErrorCode(code) ? code : CliErrorCode.CompletionGateFailed;
}
