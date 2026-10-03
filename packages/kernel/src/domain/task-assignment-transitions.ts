import { validTaskAssignment } from "./task-assignment.ts";
import type {
  AssignTaskCommand,
  UnassignTaskCommand,
  Transition,
  TaskLifecycleCommand,
  TaskLifecycleSnapshot,
} from "./task-lifecycle-contract-internal-types.ts";
import { envelope, revisionIssues, lifecycleContractIssue } from "./task-lifecycle-contract-support.ts";
import type { TaskMutationEvent } from "./task-lifecycle-event.ts";

function validate(snapshot: TaskLifecycleSnapshot, command: TaskLifecycleCommand) {
  const issues = revisionIssues(snapshot, command);
  if (!snapshot.task || (snapshot.lease && snapshot.lease.phase !== "orphaned"))
    issues.push(
      lifecycleContractIssue(
        "invalid_transition",
        "Assignment requires an existing task with no reserving or held lease.",
      ),
    );
  return issues;
}
export const assignTask: Transition = {
  actionId: "assign",
  matches: (command) => command.type === "AssignTask",
  validate: (snapshot, raw) => {
    const command = raw as AssignTaskCommand,
      issues = validate(snapshot, command);
    if (
      !validTaskAssignment(command.assignment) ||
      Date.parse(command.assignment.expiresAt) <= Date.parse(command.occurredAt)
    )
      issues.push(lifecycleContractIssue("invalid_schema", "Assignment requires a valid assignee and future expiry."));
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as AssignTaskCommand,
      task = { ...snapshot.task!, assignment: command.assignment };
    return {
      snapshot: { ...snapshot, revision: command.workspaceRevision, task },
      event: envelope<TaskMutationEvent>(command, "task_assigned", {
        task,
        mutation: { command: "assign", reason: "Task assigned.", fields: ["assignment"] },
      }),
    };
  },
};
export const unassignTask: Transition = {
  actionId: "unassign",
  matches: (command) => command.type === "UnassignTask",
  validate,
  reduce: (snapshot, raw) => {
    const command = raw as UnassignTaskCommand,
      task = { ...snapshot.task!, assignment: null };
    return {
      snapshot: { ...snapshot, revision: command.workspaceRevision, task },
      event: envelope<TaskMutationEvent>(command, "task_unassigned", {
        task,
        mutation: { command: "unassign", reason: "Task assignment removed.", fields: ["assignment"] },
      }),
    };
  },
};
