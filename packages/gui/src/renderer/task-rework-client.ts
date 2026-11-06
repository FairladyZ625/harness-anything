import type { GuiActionResult, TaskSnapshotProjectionRow } from "../api/renderer-dto.ts";
import { invoke } from "./api-client-invoke.ts";
import { readGuiActionResult } from "./command-receipt.ts";
import { daemonBridgeError } from "./daemon-startup.ts";
import { isRendererRecord } from "./result-validation.ts";

export interface TaskReworkTarget {
  readonly executionId: string;
  readonly submissionDigest: string;
}

export interface TaskReworkRead {
  readonly reworkTargets: readonly TaskReworkTarget[];
  readonly task: TaskSnapshotProjectionRow["snapshot"]["task"];
}

export type TaskReworkInput = TaskReworkTarget & {
  readonly reason: string;
  readonly agentId?: string;
};

export const taskReworkClient = {
  /** The CLI's task-show read owns the eligible cuts and the persisted handoff state. */
  async read(repoId: string, taskId: string): Promise<TaskReworkRead> {
    const request = { repoId, taskId },
      receipt = readGuiActionResult(await invoke("repo.task.show", request, "showTask"));
    if (!receipt.ok || typeof receipt.evidence !== "string")
      throw daemonBridgeError(receipt, "Task execution arrangement read failed.");
    const data = JSON.parse(receipt.evidence) as TaskReworkRead;
    // This is a transport shape check, not a second cut/digest or readiness judgment.
    if (
      !isRendererRecord(data) ||
      !Array.isArray(data.reworkTargets) ||
      !data.reworkTargets.every(
        (target) => typeof target.executionId === "string" && typeof target.submissionDigest === "string",
      ) ||
      (data.task !== null && !isRendererRecord(data.task))
    )
      throw new Error("Task-show response has no execution arrangement projection; reload matching GUI/daemon builds.");
    return data;
  },
  async rework(repoId: string, taskId: string, input: TaskReworkInput): Promise<GuiActionResult> {
    const request = { repoId, taskId, takeover: true, ...input };
    return readGuiActionResult(await invoke("repo.task.rework", request, "reworkTask"));
  },
};
