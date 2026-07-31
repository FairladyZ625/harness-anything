import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "@harness-anything/application";
import type { DomainStatus, EngineError, WriteError } from "@harness-anything/kernel";
import { explainStatusTransition, isTerminalStatus } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { demotedGateWarning } from "../../cli/demoted-gate-warning.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult } from "../../cli/types.ts";
import { withAuditedCancellationLease } from "./task-cancellation-lease.ts";
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
  return Effect.gen(function* () {
    const taskPolicy = yield* readTaskLifecyclePolicy(context.artifactStore, action.taskId);
    if (taskPolicy?.engine === "local") {
      if (action.status === "cancelled" && action.force) {
        return yield* runLocalAuditedCancellation(context, action, taskPolicy.status);
      }
      return yield* runTaskLifecycleCommand(context, command).pipe(Effect.map((result) => {
        if (result.ok || result.error?.code !== "terminal_status_requires_task_complete") return result;
        return {
          ...result,
          error: {
            ...result.error,
            hint: terminalStatusRecoveryHint(action.taskId, action.status === "done" ? "done" : "cancelled")
          }
        };
      }));
    }

    const result = yield* context.engine.setStatus({ taskId: action.taskId, status: action.status });
    const warning = demotedGateWarning(
      "terminal_status_requires_task_complete",
      `External-engine terminal status completed outside the local consent transaction. Preferred path: ha task complete ${action.taskId} --approve. If the task is already terminal and more work is required, run ha task supersede ${action.taskId} --title <follow-up-title>.`
    );
    return {
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status,
      warnings: [warning]
    };
  });
}

function runLocalAuditedCancellation(
  context: CommandRunnerContext,
  action: StatusSetAction,
  currentStatus?: DomainStatus | null
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (currentStatus && !explainStatusTransition(currentStatus, "cancelled").allowed) {
    return Effect.succeed({
      ok: false,
      command: "status-set",
      taskId: action.taskId,
      status: "cancelled",
      error: cliError(CliErrorCode.InvalidTransition, `invalid transition: ${currentStatus} -> cancelled; move the task to active before task complete, or use task archive/task supersede for non-completion closure.`)
    } satisfies CliResult);
  }
  return withAuditedCancellationLease(context, action.taskId, Effect.gen(function* () {
    const audit = yield* context.engine.appendProgress({
      taskId: action.taskId,
      text: renderForceStatusAudit("cancelled", action.reason ?? "unspecified")
    });
    const result = yield* context.engine.setStatus({ taskId: action.taskId, status: "cancelled" });
    return {
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status,
      path: audit.path,
      forced: true,
      forceAudit: { path: audit.path, marker: FORCE_STATUS_AUDIT_MARKER },
      warnings: taskTreeSoftGateWarnings(context, action.taskId)
    } satisfies CliResult;
  }));
}

function terminalStatusRecoveryHint(taskId: string, status: "done" | "cancelled"): string {
  const preferred = `Preferred path: ha task complete ${taskId} --approve. If the task is already terminal and more work is required, run ha task supersede ${taskId} --title <follow-up-title>.`;
  return status === "done"
    ? `Direct done is blocked because completion consent is recorded only by task complete. ${preferred}`
    : `Direct cancellation is blocked unless it is an audited recovery. ${preferred} For cancellation recovery, run ha task transition ${taskId} cancelled --force --reason "<reason>".`;
}
