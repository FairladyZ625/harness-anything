import type {
  TaskSubmitSubmission,
  TaskSubmitTransitionCommand
} from "./daemon-host-contract.ts";

export class TaskSubmitTransitionCommandDecodeError extends Error {
  constructor(path: string, expected: string) {
    super(`TASK_SUBMIT_TRANSITION_COMMAND_INVALID:${path}:${expected}`);
    this.name = "TaskSubmitTransitionCommandDecodeError";
  }
}

export function decodeTaskSubmitTransitionCommand(
  value: unknown,
  path = "$.action"
): TaskSubmitTransitionCommand {
  const action = taskSubmitRecord(value, path);
  taskSubmitExactKeys(action, [
    "kind", "taskId", "executionId", "leaseToken", "submission",
    "callerIdempotencyKey", "dryRun"
  ], path);
  if (action.kind !== "task-submit") taskSubmitInvalid(`${path}.kind`, "task-submit");
  if (typeof action.dryRun !== "boolean") taskSubmitInvalid(`${path}.dryRun`, "boolean");
  return {
    kind: "task-submit",
    taskId: taskSubmitText(action.taskId, `${path}.taskId`),
    executionId: taskSubmitNullableText(action.executionId, `${path}.executionId`),
    leaseToken: taskSubmitNullableText(action.leaseToken, `${path}.leaseToken`),
    submission: decodeSubmission(action.submission, `${path}.submission`),
    callerIdempotencyKey: taskSubmitText(
      action.callerIdempotencyKey,
      `${path}.callerIdempotencyKey`
    ),
    dryRun: action.dryRun
  };
}

function decodeSubmission(value: unknown, path: string): TaskSubmitSubmission {
  const submission = taskSubmitRecord(value, path);
  taskSubmitExactKeys(submission, [
    "completionClaim", "deliverables", "verificationNotes", "knownGaps",
    "residualRisks", "outputs"
  ], path);
  return {
    completionClaim: taskSubmitText(submission.completionClaim, `${path}.completionClaim`),
    deliverables: taskSubmitStringList(submission.deliverables, `${path}.deliverables`),
    verificationNotes: taskSubmitStringList(submission.verificationNotes, `${path}.verificationNotes`),
    knownGaps: taskSubmitStringList(submission.knownGaps, `${path}.knownGaps`),
    residualRisks: taskSubmitStringList(submission.residualRisks, `${path}.residualRisks`),
    outputs: taskSubmitStringList(submission.outputs, `${path}.outputs`)
  };
}

function taskSubmitStringList(value: unknown, path: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) taskSubmitInvalid(path, "array of non-empty strings");
  return value.map((entry, index) => taskSubmitText(entry, `${path}[${index}]`));
}

function taskSubmitNullableText(value: unknown, path: string): string | null {
  return value === null ? null : taskSubmitText(value, path);
}

function taskSubmitText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    taskSubmitInvalid(path, "non-empty string");
  }
  return value;
}

function taskSubmitRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    taskSubmitInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    taskSubmitInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

function taskSubmitExactKeys(
  recordValue: Record<string, unknown>,
  required: ReadonlyArray<string>,
  path: string
): void {
  const actual = Object.keys(recordValue);
  const unknown = actual.find((key) => !required.includes(key));
  if (unknown) taskSubmitInvalid(`${path}.${unknown}`, "no unknown fields");
  const missing = required.find((key) => !Object.hasOwn(recordValue, key));
  if (missing) taskSubmitInvalid(`${path}.${missing}`, "required field");
}

function taskSubmitInvalid(path: string, expected: string): never {
  throw new TaskSubmitTransitionCommandDecodeError(path, expected);
}
