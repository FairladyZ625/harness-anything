import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "@harness-anything/application";
import type { EngineError, WriteError } from "@harness-anything/kernel";
import { explainStatusTransition, isTerminalStatus } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { demotedGateWarning } from "../../cli/demoted-gate-warning.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import {
  FORCE_STATUS_AUDIT_MARKER,
  renderForceStatusAudit,
  runTaskLifecycleCommand,
  taskTreeSoftGateWarnings
} from "./task-lifecycle.ts";

type StatusSetAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "status-set" }>;

export const runTaskLifecycleWithDemotions: CommandRunner = (context, command) => {
  const action = command.action;
  if (
    action.kind !== "status-set"
    || action.executionSubmission
    || action.status === "in_review"
    || !isTerminalStatus(action.status)
  ) {
    return runTaskLifecycleCommand(context, command);
  }
  return runDemotedTerminalStatus(context, action);
};

function runDemotedTerminalStatus(
  context: CommandRunnerContext,
  action: StatusSetAction
): Effect.Effect<CliResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const taskPolicy = yield* readTaskLifecyclePolicy(context.artifactStore, action.taskId);
    if (taskPolicy?.engine !== "local") {
      const result = yield* context.engine.setStatus({ taskId: action.taskId, status: action.status });
      return {
        ok: true,
        command: "status-set",
        taskId: result.taskId,
        status: result.status
      } satisfies CliResult;
    }
    if (taskPolicy.status === "in_review") {
      return {
        ok: false,
        command: "status-set",
        taskId: action.taskId,
        status: action.status,
        error: cliError(
          CliErrorCode.ExecutionReviewRequired,
          "A Task in review can leave that state only through an execution-scoped Review transaction. Use changes_requested to return it to active."
        )
      } satisfies CliResult;
    }
    if (taskPolicy.status && !explainStatusTransition(taskPolicy.status, action.status).allowed) {
      return {
        ok: false,
        command: "status-set",
        taskId: action.taskId,
        status: action.status,
        error: cliError(
          CliErrorCode.InvalidTransition,
          `invalid transition: ${taskPolicy.status} -> ${action.status}; move the task to active before task complete, or use task archive/task supersede for non-completion closure.`
        )
      } satisfies CliResult;
    }

    const audit = action.force
      ? yield* context.engine.appendProgress({
          taskId: action.taskId,
          text: renderForceStatusAudit(action.status, action.reason ?? "unspecified")
        })
      : undefined;
    const result = yield* context.engine.setStatus({ taskId: action.taskId, status: action.status });
    const warning = demotedGateWarning(
      "terminal_status_requires_task_complete",
      `Direct terminal status transition bypassed the owner approval path. Preferred path: ha task complete ${action.taskId} --approve. If the task is already terminal and more work is required, run ha task supersede ${action.taskId} --title <follow-up-title>.`
    );
    return {
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status,
      ...(audit ? {
        path: audit.path,
        forced: true,
        forceAudit: { path: audit.path, marker: FORCE_STATUS_AUDIT_MARKER }
      } : {}),
      warnings: [warning, ...(taskTreeSoftGateWarnings(context, action.taskId) ?? [])]
    } satisfies CliResult;
  });
}
