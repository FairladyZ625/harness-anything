import type { TaskProjection } from "@harness-anything/kernel";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { repositoryRuntimeReads } from "./repository-runtime-reads.ts";
import { readTaskRuntimeContext } from "./task-runtime-context-read.ts";
import { readEdgeViewBlob } from "./runtime-result-read.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

export function readEdgeRuntimeRepository(
  input: {
    readonly viewRoot: string;
    readonly repoId: string;
    readonly nodeId: string;
    readonly workspaceRoot: string;
    readonly principalId: string | undefined;
  },
  method: "repo.tasks.runtimeContext.read" | "repo.agentRuntime.overview" | "repo.agentRuntime.sessions.read",
  payload: JsonObject,
): JsonObject {
  return withEdgeReadModel(input, (projection, frame, view) => {
    const source = projection as TaskProjection;
    if (method === "repo.tasks.runtimeContext.read") {
      if (typeof payload.taskId !== "string" || !payload.taskId) throw new Error("Task context requires a task id");
      return {
        ...readTaskRuntimeContext(input.workspaceRoot, source, payload.taskId),
        ...frame,
      } as unknown as JsonObject;
    }
    const reads = repositoryRuntimeReads(source, {
      readContentBlob: (sha256) => readEdgeViewBlob(input.viewRoot, view, sha256),
    });
    return {
      ...(method === "repo.agentRuntime.overview" ? reads.overview(payload) : reads.session(payload)),
      ...frame,
    } as unknown as JsonObject;
  });
}
