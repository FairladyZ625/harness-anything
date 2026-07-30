import type { TaskHolderPrincipal } from "@harness-anything/kernel";
import { evaluateTaskReturnToIdeaGate } from "../task-lifecycle-gates.ts";
import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";

export interface TaskReturnToIdeaSnapshotV1 {
  readonly taskId: string;
  readonly activeExecutions: ReadonlyArray<{ readonly executionId: string }>;
  readonly activeLease: {
    readonly holder: TaskHolderPrincipal;
    readonly executionId?: string;
    readonly leaseExpiresAt: string;
  } | null;
}

export type ReadTaskReturnToIdeaSnapshotV1 = (
  taskId: string
) => Promise<TaskReturnToIdeaSnapshotV1>;

export function taskReturnToIdeaPublicationRevalidation(
  readSnapshot: ReadTaskReturnToIdeaSnapshotV1 | undefined,
  taskId: string
): () => Promise<void> {
  return async () => {
    if (!readSnapshot) throw admission("TASK_RETURN_TO_IDEA_POLICY_UNAVAILABLE");
    const snapshot = await readSnapshot(taskId);
    if (snapshot.taskId !== taskId) throw admission("TASK_RETURN_TO_IDEA_POLICY_INVALID: task identity mismatch.");
    const result = evaluateTaskReturnToIdeaGate(snapshot);
    if (!result.ok) {
      throw admission(`TASK_RETURN_TO_IDEA_BLOCKED: Task ${taskId} cannot return to planned. ${result.issues
        .map((issue) => issue.message)
        .join(" ")}`);
    }
  };
}
