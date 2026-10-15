import type { AgentRuntimeEventV1 } from "@harness-anything/kernel";
import type { TaskDispatchRow } from "./protocol/task-dispatch-contract.ts";
import type { AgentRuntimeSettlement } from "./agent-runtime-contract.ts";

export type RuntimeQueueEntry = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_queued" }>["payload"];
export function runtimeQueueReason(queue: RuntimeQueueEntry): string {
  return `${queue.nodeId}: ${queue.detail ?? queue.blocks.map((block) => `${block.metric}=${block.observed ?? "unavailable"} threshold=${block.threshold}`).join(", ")} since=${queue.queuedSince} next=${queue.nextCheckAt}${queue.overdue ? " overdue" : ""}`;
}
export function runtimeQueueSettlement(queue: RuntimeQueueEntry): AgentRuntimeSettlement | null {
  if (queue.terminal === null) return null;
  return {
    outcome: queue.terminal === "cancelled" ? "cancelled" : "failed",
    exitCode: 1,
    code: queue.failureCode ?? `runtime_queue_${queue.terminal}`,
    reason: queue.detail,
  };
}
export function runtimeQueueDispatchRow(queue: RuntimeQueueEntry): TaskDispatchRow {
  return {
    dispatchId: queue.dispatchId,
    runtimeSessionId: queue.runtimeSessionId,
    taskId: queue.taskId ?? "",
    executionId: queue.executionId ?? "",
    instanceId: "",
    attemptGroupId: queue.dispatchId,
    attemptIndex: 0,
    provider: { instance: "", model: null },
    classification: null,
    reason: runtimeQueueReason(queue),
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: queue.queuedSince,
    endedAt: null,
    outcome: runtimeQueueSettlement(queue)?.outcome ?? null,
    status: queue.terminal === "interrupted" ? "failed" : (queue.terminal ?? "queued"),
    queue,
    ...(queue.agentId ? { agentId: queue.agentId } : {}),
  };
}

/** Transport boundary: a waiting request has no provider/session fields. */
export function validRuntimeQueueEntry(value: unknown): value is RuntimeQueueEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 14 &&
    ["dispatchId", "runtimeSessionId", "idempotencyKey", "nodeId"].every(
      (key) => typeof row[key] === "string" && row[key] !== "",
    ) &&
    ["taskId", "executionId", "agentId"].every((key) => row[key] === null || typeof row[key] === "string") &&
    ["queuedSince", "nextCheckAt"].every(
      (key) => typeof row[key] === "string" && Number.isFinite(Date.parse(row[key])),
    ) &&
    (row.failureCode === null || typeof row.failureCode === "string") &&
    typeof row.overdue === "boolean" &&
    (row.detail === null || typeof row.detail === "string") &&
    (row.terminal === null || ["cancelled", "failed", "interrupted"].includes(String(row.terminal))) &&
    Array.isArray(row.blocks) &&
    row.blocks.every(
      (block: Record<string, unknown>) =>
        block &&
        Object.keys(block).length === 3 &&
        ["sampling", "cpu", "memory", "concurrency"].includes(String(block.metric)) &&
        (block.observed === null || (typeof block.observed === "number" && Number.isFinite(block.observed))) &&
        typeof block.threshold === "number" &&
        Number.isFinite(block.threshold),
    )
  );
}
