import { submissionDigest, type ExecutionV1 } from "@harness-anything/kernel";

/** Stable key for a task-review dispatch; shared by the review dispatcher and the proof reads
 * that compare a stored dispatch against the execution it was opened for. */
export function reviewDispatchKey(taskId: string, execution: ExecutionV1, reviewerId?: string): string {
  const key = `task-review:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
  return reviewerId ? `${key}:reviewer:${reviewerId}` : key;
}
