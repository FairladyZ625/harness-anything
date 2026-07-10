import path from "node:path";
import { Effect } from "effect";
import { makeTaskLifecycleOrchestrator, type TaskLifecycleResult } from "../../../../application/src/index.ts";
import { makeLocalVersionControlSystem, taskDocumentPath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode, type CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { runDistillCommand } from "./distill.ts";
import { docSyncDirtyWarnings } from "./doc-sync.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./task-document-placeholders.ts";
import { taskTreeSoftGateWarnings } from "./task-lifecycle.ts";

type TaskGateAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-review" | "task-complete" }>;

export const runTaskGatesCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskGateAction;
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    taskWriter: context.engine,
    artifactStore: context.artifactStore,
    documentPlaceholderPolicy: bundledTaskDocumentPlaceholderPolicy(),
    codeDocVersionControlSystem: makeLocalVersionControlSystem()
  });
  if (action.kind === "task-review") {
    return orchestrator.reviewTask({ taskId: action.taskId, reviewerId: action.reviewerId }).pipe(
      Effect.map((result): CliResult => taskLifecycleResultToCliResult("task-review", result))
    );
  }
  return orchestrator.completeTask({ taskId: action.taskId, reviewerId: action.reviewerId, ciGate: action.ciGate }).pipe(
    Effect.map((result): CliResult => {
      const output = taskLifecycleResultToCliResult("task-complete", result);
      if (!output.ok) return output;
      return { ...output, warnings: [...(taskTreeSoftGateWarnings(context, action.taskId) ?? []), ...(docSyncDirtyWarnings(context.layoutInput) ?? [])] };
    }),
    Effect.flatMap((output) => output.ok ? queueCloseoutDistillCandidate(context, command, action, output) : Effect.succeed(output))
  );
};

function taskLifecycleResultToCliResult(command: "task-review" | "task-complete", result: TaskLifecycleResult): CliResult {
  if (result.ok) {
    return {
      ok: true,
      command,
      taskId: result.taskId,
      status: result.status,
      report: result.report,
      reviewContract: result.reviewContract,
      completionGate: result.completionGate
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

function queueCloseoutDistillCandidate(
  context: Parameters<CommandRunner>[0],
  command: Parameters<CommandRunner>[1],
  action: Extract<TaskGateAction, { readonly kind: "task-complete" }>,
  output: CliResult
): ReturnType<CommandRunner> {
  const inputPath = taskCloseoutInputPath(context, action.taskId);
  return runDistillCommand(context, {
    ...command,
    action: {
      kind: "distill-candidate",
      taskId: action.taskId,
      inputPath
    }
  }).pipe(
    Effect.match({
      onFailure: (error): CliResult => withDistillCandidateWarning(output, `distill candidate write failed: ${JSON.stringify(error)}`),
      onSuccess: (candidate): CliResult => candidate.ok
        ? withDistillCandidateReport(output, candidate)
        : withDistillCandidateWarning(output, candidate.error?.hint ?? "distill candidate was not queued")
    })
  );
}

function taskCloseoutInputPath(context: Parameters<CommandRunner>[0], taskId: string): string {
  return path.relative(context.rootDir, taskDocumentPath(context.layoutInput, taskId, "closeout.md")).split(path.sep).join("/");
}

function withDistillCandidateReport(output: CliResult, candidate: CliResult): CliResult {
  return {
    ...output,
    report: {
      ...(isCliReportRecord(output.report) ? output.report : { schema: "task-complete-report/v1" }),
      distillCandidate: {
        queued: true,
        path: candidate.path,
        report: candidate.report
      }
    }
  };
}

function withDistillCandidateWarning(output: CliResult, reason: string): CliResult {
  return {
    ...output,
    report: {
      ...(isCliReportRecord(output.report) ? output.report : { schema: "task-complete-report/v1" }),
      distillCandidate: {
        queued: false,
        reason
      }
    },
    warnings: [
      ...(output.warnings ?? []),
      {
        code: "distill_candidate_not_queued",
        message: reason
      }
    ]
  };
}

function isCliReportRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskGateHint(code: string, hint: string, taskId: string): string {
  if (/review\.md material findings table failed validation/i.test(hint)) return `${hint} Valid severity values: P0, P1, P2, P3.`;
  if (code !== "closeout_not_ready" && !/closeout/i.test(hint)) return hint;
  return [
    hint,
    `To make closeoutReadiness ready/passed, run ha task transition ${taskId} in_review, replace closeout.md placeholder content with real Summary/Verification/Residual Risk, run ha fact record --task ${taskId} --statement "..." --source "..." for evidence, run ha task review ${taskId}, then run ha task complete ${taskId} --ci passed.`
  ].join(" ");
}

function cliErrorCode(code: string): CliErrorCodeValue {
  // The orchestrator's writeFailureCode maps every kernel writer/engine error to a
  // registered CLI error code, so a real write failure (e.g. malformed_snapshot,
  // write_rejected) passes through untouched and surfaces its true cause. The
  // CompletionGateFailed fallback is a defensive guard for an unexpected unregistered
  // code, not the normal path — it must not mask a recognized writer error code.
  if (isCliErrorCode(code)) return code;
  return CliErrorCode.CompletionGateFailed;
}
