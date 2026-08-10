import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "@harness-anything/application";
import type { DomainStatus, EngineError, WriteControl } from "@harness-anything/kernel";
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
      `External-engine terminal status completed outside the local consent transaction. Run \`ha task show ${action.taskId} --json\` to confirm the resulting state. Do not run another terminal transition from this receipt. If follow-up work is needed, inspect \`ha task supersede --help\` before creating replacement work.`
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
): Effect.Effect<CliResult, EngineError | WriteControl> {
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
    const result = yield* context.engine.setStatus({
      taskId: action.taskId,
      status: "cancelled",
      auditText: renderForceStatusAudit("cancelled", action.reason ?? "unspecified")
    });
    return {
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status,
      path: "progress.md",
      forced: true,
      forceAudit: { path: "progress.md", marker: FORCE_STATUS_AUDIT_MARKER },
      warnings: taskTreeSoftGateWarnings(context, action.taskId)
    } satisfies CliResult;
  }));
}

function terminalStatusRecoveryHint(taskId: string, status: "done" | "cancelled"): string {
  return status === "done"
    ? `Direct done is blocked because completion consent is recorded only by the typed completion transaction. Run \`ha task show ${taskId} --json\` to confirm the current state. If the task is not terminal, inspect \`ha task complete --help\` and prepare the required approval packet before retrying completion. If it is already terminal and follow-up work is needed, inspect \`ha task supersede --help\` before creating replacement work.`
    : `Direct cancellation is blocked unless it is an audited recovery. Run \`ha task show ${taskId} --json\` to confirm the current state. If the task is not terminal and cancellation is still intended, inspect \`ha task transition --help\` and supply a truthful audited reason. If it is already terminal and follow-up work is needed, inspect \`ha task supersede --help\` before creating replacement work.`;
}
