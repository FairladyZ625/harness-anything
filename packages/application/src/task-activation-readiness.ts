import { Effect } from "effect";
import type { ArtifactStore, TaskId } from "@harness-anything/kernel";
import { readTaskProjection, sha256Text } from "@harness-anything/kernel";
import type { HarnessLayoutOverrides } from "@harness-anything/kernel";
import {
  classifyTaskPlanAdmission,
  evaluateTaskPlanAdmission
} from "./authority/task-execution-admission-policy.ts";
import type { TaskDocumentPlaceholderPolicy } from "./task-lifecycle-gates.ts";
import type { TaskLifecycleFailure } from "./task-lifecycle-orchestrator.ts";

export interface TaskActivationReadiness {
  readonly ok: true;
  readonly taskId: string;
  readonly taskPlanBodySha256: string;
}

export function validateTaskActivationReadiness(input: {
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskId: string;
  readonly policy: TaskDocumentPlaceholderPolicy;
}): Effect.Effect<TaskActivationReadiness | TaskLifecycleFailure> {
  return Effect.gen(function* () {
    const taskPackage = yield* input.artifactStore.readTaskPackage(input.taskId as TaskId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    if (taskPackage === null) {
      const taskExists = readTaskProjection({
        rootDir: input.rootDir,
        layoutOverrides: input.layoutOverrides
      }).rows.some((row) => row.taskId === input.taskId);
      if (!taskExists) return activationFailure(input.taskId, "task_not_found", `task not found: ${input.taskId}`);
    }
    const taskPlan = taskPackage?.documents.find((document) => document.path === "task_plan.md")?.body ?? null;
    const admission = evaluateTaskPlanAdmission(classifyTaskPlanAdmission({
      taskId: input.taskId,
      taskRoot: taskPackage?.rootPath ?? "the task package",
      taskPlan,
      policy: input.policy
    }));
    if (!admission.ok) return activationFailure(input.taskId, "task_plan_placeholder", admission.message);
    return {
      ok: true,
      taskId: input.taskId,
      taskPlanBodySha256: sha256Text(taskPlan!)
    };
  });
}

function activationFailure(taskId: string, code: string, hint: string): TaskLifecycleFailure {
  return { ok: false, taskId, error: { code, hint } };
}
