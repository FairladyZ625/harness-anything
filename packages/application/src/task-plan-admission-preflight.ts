import { Effect } from "effect";
import type { ArtifactStore, TaskId } from "@harness-anything/kernel";
import {
  readTaskProjection,
  type HarnessLayoutOverrides
} from "@harness-anything/kernel";
import {
  classifyTaskPlanAdmission,
  evaluateTaskPlanAdmission
} from "./authority/task-execution-admission-policy.ts";
import type { TaskDocumentPlaceholderPolicy } from "./task-lifecycle-gates.ts";

export interface TaskPlanAdmissionPreflightFailure {
  readonly code: "task_not_found" | "task_plan_placeholder";
  readonly hint: string;
}

export function validateTaskPlanAdmissionPreflight(input: {
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskId: string;
  readonly policy?: TaskDocumentPlaceholderPolicy;
}): Effect.Effect<TaskPlanAdmissionPreflightFailure | null> {
  return Effect.gen(function* () {
    if (!input.policy) return null;
    const taskPackage = yield* input.artifactStore.readTaskPackage(input.taskId as TaskId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    if (taskPackage === null) {
      const taskExists = readTaskProjection({
        rootDir: input.rootDir,
        layoutOverrides: input.layoutOverrides
      }).rows.some((row) => row.taskId === input.taskId);
      if (!taskExists) return { code: "task_not_found", hint: `task not found: ${input.taskId}` };
    }
    const plan = evaluateTaskPlanAdmission(classifyTaskPlanAdmission({
      taskId: input.taskId,
      taskRoot: taskPackage?.rootPath ?? "the task package",
      taskPlan: taskPackage?.documents.find((document) => document.path === "task_plan.md")?.body ?? null,
      policy: input.policy
    }));
    return plan.ok ? null : { code: "task_plan_placeholder", hint: plan.message };
  });
}
