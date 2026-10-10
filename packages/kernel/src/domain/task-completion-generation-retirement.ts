import { isNativeExecution, type ExecutionV1 } from "./execution.ts";
import type { CompletionGenerationRetiredEvent } from "./task-lifecycle-event.ts";
import type {
  RetireCompletionGenerationCommand,
  TaskLifecycleSnapshot,
  Transition,
} from "./task-lifecycle-contract-internal-types.ts";
import {
  envelope,
  lifecycleContractIssue,
  replaceExecution,
  revisionIssues,
} from "./task-lifecycle-contract-support.ts";

export function completionRetirementExecutions(snapshot: TaskLifecycleSnapshot) {
  return !snapshot.task || ["done", "cancelled"].includes(snapshot.task.status)
    ? []
    : snapshot.executions.filter(
        (execution): execution is ExecutionV1 =>
          isNativeExecution(execution) && ["active", "submitted"].includes(execution.state),
      );
}

/** Offline Task action, never an Execution write or a live transport capability. */
export const retireCompletionGeneration: Transition = {
  actionId: "completion-generation-retire",
  offline: true,
  matches: (command) => command.type === "RetireCompletionGeneration",
  validate: (snapshot, raw) => {
    const command = raw as RetireCompletionGenerationCommand,
      current = completionRetirementExecutions(snapshot).find((value) => value.executionId === command.executionId),
      issues = revisionIssues(snapshot, command);
    if (!current || (command.sourceGeneration !== 1 && command.sourceGeneration !== 2))
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          "offline completion retirement requires an unfinished execution and task",
        ),
      );
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as RetireCompletionGenerationCommand,
      current = snapshot.executions.find((value) => value.executionId === command.executionId) as ExecutionV1,
      execution: ExecutionV1 = { ...current, state: "abandoned", closedAt: command.occurredAt },
      task = {
        ...snapshot.task!,
        status: "active" as const,
        currentNode: "implementation" as const,
        iteration: Math.max(snapshot.task!.iteration, current.iteration + 1),
      };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        executions: replaceExecution(snapshot.executions, execution),
        lease: null,
      },
      event: envelope<CompletionGenerationRetiredEvent>(command, "task_completion_generation_retired", {
        task,
        execution,
        sourceGeneration: command.sourceGeneration,
      }),
    };
  },
};
