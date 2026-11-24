import {
  makeTaskQueryReadModel as makeApplicationTaskQueryReadModel,
  runtimeDispatchEdges,
  taskPackageDisposition,
  type AgendaQuery,
  type TaskQueryJudgments,
  type TaskQueryReadModel,
} from "@harness-anything/application/internal/queries/task-query-read.ts";
import { daemonTaskCoreQueryPorts } from "./task-core-query-ports.ts";

export { runtimeDispatchEdges, taskPackageDisposition };
export type { AgendaQuery, TaskQueryJudgments, TaskQueryReadModel };

export function makeTaskQueryReadModel(
  input: Omit<Parameters<typeof makeApplicationTaskQueryReadModel>[0], "ports">,
): TaskQueryReadModel {
  return makeApplicationTaskQueryReadModel({ ...input, ports: daemonTaskCoreQueryPorts });
}
