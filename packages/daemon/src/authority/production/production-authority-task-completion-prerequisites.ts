import {
  taskAuthorityCompletionPrerequisites,
  type TaskAuthorityCompletionPrerequisiteId,
  type TaskCompletionPrerequisiteInput,
  type TaskCompletionPrerequisiteResult
} from "@harness-anything/application";

export const productionTaskCompletionPrerequisiteIds: ReadonlyArray<TaskAuthorityCompletionPrerequisiteId> =
  taskAuthorityCompletionPrerequisites.map((entry) => entry.id);

export function assertProductionTaskCompletionPrerequisites(
  input: TaskCompletionPrerequisiteInput
): ReadonlyArray<TaskCompletionPrerequisiteResult<TaskAuthorityCompletionPrerequisiteId>> {
  const results = taskAuthorityCompletionPrerequisites.map((entry) => entry.evaluate(input));
  const failure = results.find((result) => !result.ok);
  if (failure && !failure.ok) throw new Error(failure.errorCode);
  return results;
}
