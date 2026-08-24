import { createHash } from "node:crypto";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";

const cancelDurableDrainTimeoutMs = 1_000;

export async function cancelRuntime(context: any, payload: JsonObject, binding: RuntimeBinding): Promise<JsonObject> {
  const allowed = ["runtimeSessionId"],
    unknownField = unknownFieldViolation(payload, allowed);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_cancel", `Runtime cancel payload contains an ${unknownField}`);
  const runtimeSessionId = requiredRuntimeSpawnText(payload.runtimeSessionId, "runtimeSessionId"),
    hash = createHash("sha256").update(`${context.input.repoId}\0${runtimeSessionId}`).digest("hex"),
    opId = `runtime-cancel-${hash.slice(0, 32)}`,
    active = context.processes.get(runtimeSessionId);
  if (active) {
    active.cancelBinding = binding;
    active.cancelOpId = opId;
    active.cancelRequested = true;
    await consumeDurableOutput(context, active, cancelDurableDrainTimeoutMs);
    if (active.process.terminateTree) await active.process.terminateTree();
    else active.process.terminate();
    await context.publishExit(active, null);
    return context.controlReceipt(opId, runtimeSessionId);
  }
  return context.controlReceipt(opId, runtimeSessionId, "already-exited");
}

export function closeRuntimes(context: any): void {
  const active = [...context.processes.values()];
  context.processes.clear();
  for (const entry of active) entry.process.release?.();
}
