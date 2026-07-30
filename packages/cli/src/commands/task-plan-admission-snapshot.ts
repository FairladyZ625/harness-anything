import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyTaskPlanAdmission,
  type TaskPlanAdmissionSnapshotV1
} from "@harness-anything/application";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { findAuthoredTaskRoot } from "./task-authored-source.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./core/task-document-placeholders.ts";

export async function readTaskPlanAdmissionSnapshot(
  rootInput: HarnessLayoutInput,
  taskId: string
): Promise<TaskPlanAdmissionSnapshotV1> {
  const taskRoot = findAuthoredTaskRoot(rootInput, taskId);
  const taskPlanPath = path.join(taskRoot, "task_plan.md");
  return classifyTaskPlanAdmission({
    taskId,
    taskRoot,
    taskPlan: existsSync(taskPlanPath) ? readFileSync(taskPlanPath, "utf8") : null,
    policy: bundledTaskDocumentPlaceholderPolicy()
  });
}
