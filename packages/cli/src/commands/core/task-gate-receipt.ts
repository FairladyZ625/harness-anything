import type { TaskLifecycleResult } from "@harness-anything/application";
import { cliError, CliErrorCode, isCliErrorCode, type CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function taskLifecycleResultToCliResult(
  command: "task-review" | "task-complete",
  result: TaskLifecycleResult,
  completionEvidencePath = "completion-evidence.json"
): CliResult {
  if (result.ok) {
    return {
      ok: true,
      command,
      taskId: result.taskId,
      executionId: result.executionId,
      status: result.status,
      report: result.report,
      reviewContract: result.reviewContract,
      completionGate: result.completionGate,
      completionEvidence: result.completionEvidence ? {
        schema: "task-completion-evidence-receipt/v1",
        mode: result.completionEvidence.mode,
        path: completionEvidencePath,
        sha: result.completionEvidence.anchor.sha,
        codeDocRecordIds: result.completionEvidence.anchor.codeDocRecordIds,
        judge: {
          principal: result.completionEvidence.judgment.actor.principal.personId,
          executor: result.completionEvidence.judgment.actor.executor?.id ?? null
        },
        rationale: result.completionEvidence.judgment.rationale,
        verifiedObjectType: "commit"
      } : undefined
    };
  }
  return {
    ok: false,
    command,
    taskId: result.taskId,
    report: result.report,
    issues: result.issues,
    completionGate: result.completionGate,
    error: cliError(cliErrorCode(result.error.code), taskGateHint(result.error.code, result.error.hint, result.taskId))
  };
}

function taskGateHint(code: string, hint: string, taskId: string): string {
  if (hint.startsWith("Task completion has ")) return hint;
  if (/review\.md material findings table failed validation/i.test(hint)) return `${hint} Valid severity values: P0, P1, P2, P3.`;
  if (code === CliErrorCode.CodeDocReconciliationFailed) {
    return `${hint} Generate the required file with ha task code-doc reconcile ${taskId} --commit <full-sha> [--path <repo-relative-path>]... [--pr <url>].`;
  }
  if (code !== "closeout_not_ready" && !/closeout/i.test(hint)) return hint;
  return [
    hint,
    `Replace closeout.md placeholders with real Summary/Verification/Residual Risk, then rerun ha task complete ${taskId}; add --ci passed only when the resolved completionGates declares ci.`
  ].join(" ");
}

function cliErrorCode(code: string): CliErrorCodeValue {
  return isCliErrorCode(code) ? code : CliErrorCode.CompletionGateFailed;
}
