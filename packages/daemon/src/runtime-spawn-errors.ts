import type { AgentRuntimeEventV1, ReceiptDiagnostic, TaskProjection } from "@harness-anything/kernel";
import { scrubProviderValue } from "./dispatch-stream.ts";

export function requiredRuntimeSpawnText(value: unknown, field: string): string {
  if (typeof value === "string" && value.length) return value;
  throw runtimeSpawnError("invalid_runtime_spawn", `${field} is required.`);
}

export function runtimeTaskExecutionFrozenError(taskId: string, status: string): Error {
  return runtimeSpawnError(
    "execution_frozen",
    `Task ${taskId} is ${status}: the round was submitted and its cut is frozen, so an implementation runtime ` +
      "cannot write to it.",
    {
      kind: "validation",
      entity: `task ${taskId}`,
      field: "taskId",
      actual: status,
      expectation:
        `Expected a task in implementation; the owner returns the cut with ha task adjudicate ${taskId} --return, ` +
        `then retry the dispatch, review it with ha task dispatch-review ${taskId} --agent <reviewer-agent-id>, ` +
        `or attach a read-only Agent (permissionMode read-only in its declaration) with ` +
        `ha agent run <read-only-agent-id> --task ${taskId}`,
    },
  );
}

export function runtimeTaskLeaseRequiredMessage(
  taskId: string,
  lease: ReturnType<TaskProjection["currentLease"]>,
): string {
  if (lease === null)
    return [
      "Task-bound runtime spawn requires the caller's active execution lease; ",
      "run ha task start ",
      `${taskId}`,
      ", then retry the task-bound runtime command.",
    ].join("");
  const executor = lease.actor.executor === null ? "none" : `${lease.actor.executor.kind}:${lease.actor.executor.id}`,
    holder = `personId=${lease.actor.principal.personId}, executor=${executor}`;
  if (lease.phase === "held")
    return [
      "Task-bound runtime spawn requires the caller's active execution lease; ",
      "holder (",
      `${holder}`,
      ") must run ha task release ",
      `${taskId}`,
      ", then this caller can run ha task start ",
      `${taskId}`,
      ", then retry the task-bound runtime command.",
    ].join("");
  if (lease.phase === "orphaned")
    return [
      "Task-bound runtime spawn requires the caller's active execution lease; ",
      "the lease for execution ",
      `${lease.executionId}`,
      " lapsed at ",
      `${lease.expiresAt}`,
      "; run ha task release ",
      `${taskId}`,
      ", then run ha task start ",
      `${taskId}`,
      " --execution-id ",
      `${lease.executionId}`,
      " before retrying the task-bound runtime command.",
    ].join("");
  if (lease.phase === "reserving")
    return [
      "Task-bound runtime spawn requires the caller's active execution lease; ",
      "wait for the reservation for execution ",
      `${lease.executionId}`,
      " to publish or lapse at ",
      `${lease.expiresAt}`,
      ", then retry the task-bound runtime command.",
    ].join("");
  return [
    "Task-bound runtime spawn requires the caller's active execution lease; ",
    "run ha task start ",
    `${taskId}`,
    " --execution-id ",
    `${lease.executionId}`,
    ", then retry the task-bound runtime command.",
  ].join("");
}

export function runtimeSpawnError(code: string, message: string, diagnostic?: ReceiptDiagnostic): Error {
  return Object.assign(new Error(message), { code, ...(diagnostic ? { diagnostic } : {}) });
}

export function runtimeErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

export function runtimeErrorMessage(error: unknown): string {
  return String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 1024);
}

export function isRuntimeEvent(value: { readonly schema: string }): value is AgentRuntimeEventV1 {
  return value.schema === "agent-runtime-event/v1";
}
