import type { TaskDispatchRow } from "./protocol/task-dispatch-contract.ts";

/** A live dispatch with no observation for this long is surfaced as silent. */
export const DISPATCH_SILENT_AFTER_MS = 10 * 60_000;

export type DispatchActivityStatus = "thinking" | "tool" | "waiting" | "silent" | "stalled" | "unknown";
export type DispatchProviderActivity = Exclude<DispatchActivityStatus, "silent" | "stalled" | "unknown">;

/**
 * The daemon owns this judgment so every renderer sees the same activity state. A submitted
 * implementation is waiting on the PR/CI/review path; a reviewer remains active work. Silent
 * means that the last real observation is beyond the threshold. `processAlive` is null when the
 * dispatch stream carries no process record — that signal is absent, not false.
 */
export function dispatchActivityStatus(
  input: {
    readonly status: TaskDispatchRow["status"];
    readonly taskStatus: string | undefined;
    readonly role: string | undefined;
    readonly lastObservedAt: string;
    readonly lastProgressAt?: string;
    readonly stallTimeoutMs?: number;
    readonly stalledAt?: string | null;
    readonly processAlive: boolean | null;
    readonly providerActivity: DispatchProviderActivity | null;
  },
  nowMs = Date.now(),
): DispatchActivityStatus {
  if (input.status !== "running") return "unknown";
  if (input.stalledAt) return "stalled";
  const progressAt = Date.parse(input.lastProgressAt ?? input.lastObservedAt);
  if (
    input.processAlive !== false &&
    input.stallTimeoutMs !== undefined &&
    Number.isFinite(progressAt) &&
    nowMs - progressAt >= input.stallTimeoutMs
  )
    return "stalled";
  if (input.taskStatus === "submitted" && input.role !== "reviewer") return "waiting";
  if (input.processAlive === false) return "silent";
  if (Number.isFinite(progressAt) && nowMs - progressAt >= DISPATCH_SILENT_AFTER_MS) return "silent";
  return input.providerActivity ?? "thinking";
}

/** Whole minutes since the activity observation; the renderer only formats this integer. */
export function dispatchActivityIdleMinutes(lastObservedAt: string, nowMs = Date.now()): number {
  const observedAt = Date.parse(lastObservedAt);
  return Number.isFinite(observedAt) && nowMs >= observedAt ? Math.floor((nowMs - observedAt) / 60_000) : 0;
}

/** Provider events are reduced to a tiny vocabulary at the daemon boundary. */
export function dispatchProviderActivity(kindId: string, event: unknown): DispatchProviderActivity | null {
  if (!isRecord(event)) return null;
  const type = typeof event.type === "string" ? event.type : typeof event.event === "string" ? event.event : "";
  if (kindId === "claude") {
    if (type === "result") return "waiting";
    const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
    if (content.some((item) => isRecord(item) && ["tool_use", "server_tool_use"].includes(String(item.type))))
      return "tool";
    if (type === "assistant" || type === "user" || type === "message_start" || type === "message_delta")
      return "thinking";
  }
  if (kindId === "agy") {
    if (type === "result") return "waiting";
    const update = isRecord(event.step_update) ? event.step_update : null;
    if (type === "step_update" && update?.step_type === "tool" && update.state !== "DONE" && update.state !== "ERROR")
      return "tool";
    if (type === "step_update") return "thinking";
  }
  if (kindId === "codex") {
    if (type === "turn.completed" || type === "turn.failed") return "waiting";
    const item = isRecord(event.item) ? event.item : null,
      itemType = item && typeof item.type === "string" ? item.type : null;
    if (itemType && codexToolItemTypes.has(itemType)) return type === "item.completed" ? "thinking" : "tool";
    if (type === "item.started" || type === "item.updated" || type === "item.completed" || type === "turn.started")
      return "thinking";
  }
  if (kindId === "zcode") {
    if (type === "result" || type === "turn.failed") return "waiting";
    const payload = isRecord(event.payload) ? event.payload : null,
      payloadKind = payload && typeof payload.kind === "string" ? payload.kind : "";
    if (payloadKind === "tool_call") return "tool";
    if (type === "model.streaming" || type === "turn.started") return "thinking";
  }
  if (type === "acp.result" || type === "acp.error") return "waiting";
  if (type === "acp.update") {
    const update = isRecord(event.update) ? event.update : null,
      updateKind = update && typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (updateKind === "tool_call") return "tool";
    if (updateKind === "agent_message_chunk" || updateKind === "agent_thought_chunk") return "thinking";
    if (updateKind === "tool_call_update")
      return ["completed", "failed", "cancelled"].includes(String(update?.status)) ? "thinking" : "tool";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const codexToolItemTypes: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "collab_tool_call",
]);
