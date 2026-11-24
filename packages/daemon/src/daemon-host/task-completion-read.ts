import type {
  ActorIdentity,
  CloseoutSnapshot,
  TaskLifecycleSnapshot,
  TaskProjectionQueries,
} from "@harness-anything/kernel";
import {
  factRetirementAssessment,
  readCompletionContext as readApplicationCompletionContext,
  readCompletionDeliveryStatus as readApplicationCompletionDeliveryStatus,
  readTaskCompletion as readApplicationTaskCompletion,
  requireFactRetirementAssessment,
} from "@harness-anything/application/internal/queries/task-completion-read.ts";
import { daemonTaskCoreQueryPorts } from "./task-core-query-ports.ts";

export { factRetirementAssessment, requireFactRetirementAssessment };

export function readCompletionContext(
  projection: TaskProjectionQueries,
  taskId: string,
  snapshot: TaskLifecycleSnapshot,
  status: "ready" | "pending",
  rootDir?: string,
  actor?: ActorIdentity,
) {
  return readApplicationCompletionContext(
    projection,
    taskId,
    snapshot,
    status,
    rootDir,
    actor,
    daemonTaskCoreQueryPorts,
  );
}

export function readCompletionDeliveryStatus(
  projection: TaskProjectionQueries,
  snapshot: CloseoutSnapshot,
  rootDir?: string,
) {
  return readApplicationCompletionDeliveryStatus(projection, snapshot, rootDir, daemonTaskCoreQueryPorts.git);
}

export function readTaskCompletion(
  projection: TaskProjectionQueries,
  taskId: string,
  rootDir?: string,
  actor?: ActorIdentity,
) {
  return readApplicationTaskCompletion(projection, taskId, rootDir, actor, daemonTaskCoreQueryPorts);
}
