import { createHash } from "node:crypto";
import {
  decodeTaskSubmitTransitionCommand,
  type TaskSubmitTransitionCommand
} from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";
import type { CliTaskSubmitAction } from "./types.ts";

export function makeTaskSubmitTransitionCommand(
  command: Omit<TaskSubmitTransitionCommand, "callerIdempotencyKey">,
  providedKey?: string
): TaskSubmitTransitionCommand {
  return decodeTaskSubmitTransitionCommand({
    ...command,
    callerIdempotencyKey: providedKey ?? `task-submit-${createHash("sha256")
      .update(stableStringify(command))
      .digest("hex")}`
  });
}

/** Project the CLI grammar shape into the exact daemon-host command contract. */
export function taskSubmitTransitionCommandFromCliAction(
  value: unknown
): TaskSubmitTransitionCommand {
  const action = cliTaskSubmitRecord(value, "$.action");
  if (Object.hasOwn(action, "callerIdempotencyKey")) {
    return decodeTaskSubmitTransitionCommand(action);
  }
  cliTaskSubmitExactKeys(action, ["kind", "taskId", "submission"], [
    "executionId", "leaseToken", "dryRun"
  ], "$.action");
  if (action.kind !== "task-submit") cliTaskSubmitInvalid("$.action.kind", "task-submit");
  const cliAction = action as unknown as CliTaskSubmitAction;
  return makeTaskSubmitTransitionCommand({
    kind: "task-submit",
    taskId: cliAction.taskId,
    executionId: cliAction.executionId ?? null,
    leaseToken: cliAction.leaseToken ?? null,
    submission: cliAction.submission,
    dryRun: cliAction.dryRun === true
  });
}

function cliTaskSubmitRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    cliTaskSubmitInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

function cliTaskSubmitExactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) cliTaskSubmitInvalid(`${path}.${unknown}`, "no unknown fields");
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) cliTaskSubmitInvalid(`${path}.${missing}`, "required field");
}

function cliTaskSubmitInvalid(path: string, expected: string): never {
  throw new Error(`CLI_TASK_SUBMIT_COMMAND_INVALID:${path}:${expected}`);
}
