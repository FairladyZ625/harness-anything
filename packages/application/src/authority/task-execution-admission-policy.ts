import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";
import {
  isTaskDocumentPlaceholderMarkdown,
  type TaskDocumentPlaceholderPolicy
} from "../task-lifecycle-gates.ts";
import {
  taskWipPublicationRevalidation,
  type ReadTaskWipSnapshotV1
} from "./task-wip-policy.ts";

export interface TaskPlanAdmissionSnapshotV1 {
  readonly taskId: string;
  readonly state: "substantive" | "placeholder" | "missing";
  readonly taskRoot: string;
}

export type ReadTaskPlanAdmissionSnapshotV1 = (
  taskId: string
) => Promise<TaskPlanAdmissionSnapshotV1>;

export interface TaskExecutionAdmissionPortsV1 {
  readonly taskPlanSnapshot?: ReadTaskPlanAdmissionSnapshotV1;
  readonly taskWipSnapshot?: ReadTaskWipSnapshotV1;
}

export type TaskPlanAdmissionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function classifyTaskPlanAdmission(input: {
  readonly taskId: string;
  readonly taskRoot: string;
  readonly taskPlan: string | null;
  readonly policy: TaskDocumentPlaceholderPolicy;
}): TaskPlanAdmissionSnapshotV1 {
  const state = input.taskPlan === null
    ? "missing"
    : isTaskDocumentPlaceholderMarkdown(
      input.taskPlan,
      input.policy.taskPlanPlaceholderFingerprintSets
    )
      ? "placeholder"
      : "substantive";
  return { taskId: input.taskId, taskRoot: input.taskRoot, state };
}

export function evaluateTaskPlanAdmission(
  snapshot: TaskPlanAdmissionSnapshotV1
): TaskPlanAdmissionResult {
  if (snapshot.state === "substantive") return { ok: true };
  const action = snapshot.state === "missing" ? "Restore" : "Replace the scaffold content in";
  return {
    ok: false,
    message: `${action} ${snapshot.taskRoot}/task_plan.md with a substantive implementation plan. ` +
      `Then retry \`ha task transition ${snapshot.taskId} active\`.`
  };
}

export function taskExecutionAdmissionPublicationRevalidation(
  ports: TaskExecutionAdmissionPortsV1,
  activatingTaskId: string
): () => Promise<void> {
  return async () => {
    if (!ports.taskPlanSnapshot) throw admission("TASK_PLAN_POLICY_UNAVAILABLE");
    const snapshot = await ports.taskPlanSnapshot(activatingTaskId);
    if (snapshot.taskId !== activatingTaskId) {
      throw admission("TASK_PLAN_POLICY_INVALID: task identity mismatch.");
    }
    const plan = evaluateTaskPlanAdmission(snapshot);
    if (!plan.ok) throw admission(`TASK_PLAN_PLACEHOLDER: ${plan.message}`);
    await taskWipPublicationRevalidation(ports.taskWipSnapshot, activatingTaskId)();
  };
}
