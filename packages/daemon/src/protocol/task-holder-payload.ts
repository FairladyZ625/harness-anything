import type { TaskHolderExecutor } from "../../../application/src/index.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";

export function readTaskHolderExecutor(payload: JsonObject | undefined): TaskHolderExecutor | null {
  const executor = payload?.executor;
  if (executor === undefined || executor === null) return null;
  if (!isJsonObject(executor) || executor.kind !== "agent" || typeof executor.id !== "string" || !executor.id.trim()) {
    throw new Error("payload.executor must be null or { kind: \"agent\", id: string }.");
  }
  return { kind: "agent", id: executor.id.trim() };
}

export function readTaskHolderExecutorForEvent(payload: JsonObject | undefined): TaskHolderExecutor | null {
  try {
    return readTaskHolderExecutor(payload);
  } catch {
    return null;
  }
}
