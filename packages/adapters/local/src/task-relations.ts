import type { TaskId } from "../../../kernel/src/index.ts";

export function renderSupersedesRelation(newTaskId: TaskId, oldTaskId: TaskId, reason: string): string {
  return [
    "---",
    "schema: task-relations/v1",
    `source: task/${newTaskId}`,
    `target: task/${oldTaskId}`,
    "type: supersedes",
    "strength: strong",
    "direction: directed",
    "provenance: declared",
    "state: active",
    "---",
    "",
    "# Supersedes",
    "",
    `task/${newTaskId} supersedes task/${oldTaskId}.`,
    "",
    "## Reason",
    "",
    reason,
    ""
  ].join("\n");
}
