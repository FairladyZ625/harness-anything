import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "@harness-anything/application";
import { isTerminalStatus } from "@harness-anything/kernel";
import { demotedGateWarning } from "../../cli/demoted-gate-warning.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { runTaskLifecycleCommand } from "./task-lifecycle.ts";

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

function terminalStatusRecoveryHint(taskId: string, status: "done" | "cancelled"): string {
  const preferred = `Preferred path: ha task complete ${taskId} --approve. If the task is already terminal and more work is required, run ha task supersede ${taskId} --title <follow-up-title>.`;
  return status === "done"
    ? `Direct done is blocked because completion consent is recorded only by task complete. ${preferred}`
    : `Direct cancellation is blocked unless it is an audited recovery. ${preferred} For cancellation recovery, run ha task transition ${taskId} cancelled --force --reason "<reason>".`;
}
