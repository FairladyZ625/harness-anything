import type { TaskProjection } from "@harness-anything/kernel";
import {
  parseGitDiffPatch,
  readTaskDeliveryDiff as readApplicationTaskDeliveryDiff,
} from "@harness-anything/application/internal/queries/task-delivery-diff-read.ts";
import { daemonTaskCoreQueryPorts } from "./task-core-query-ports.ts";

export { parseGitDiffPatch };
export {
  serializeDaemonTaskDeliveryDiff,
  validateDaemonTaskDeliveryDiff,
} from "./protocol/daemon-protocol-task-delivery-diff.ts";

export function readTaskDeliveryDiff(
  rootDir: string,
  projection: Pick<TaskProjection, "read">,
  taskId: string,
) {
  return readApplicationTaskDeliveryDiff(rootDir, projection, taskId, daemonTaskCoreQueryPorts.gitDiff);
}
