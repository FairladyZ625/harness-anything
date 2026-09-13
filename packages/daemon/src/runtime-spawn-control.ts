import { createHash } from "node:crypto";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { adoptRuntimes, ownedByRuntimeNode } from "./runtime-spawn-adoption.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";

const cancelDurableDrainTimeoutMs = 1_000;

export async function cancelRuntime(
  context: RuntimeSpawnerContext,
  payload: JsonObject,
  binding: RuntimeBinding,
): Promise<JsonObject> {
  const allowed = ["runtimeSessionId"],
    unknownField = unknownFieldViolation(payload, allowed);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_cancel", `Runtime cancel payload contains an ${unknownField}`);
  const runtimeSessionId = requiredRuntimeSpawnText(payload.runtimeSessionId, "runtimeSessionId"),
    hash = createHash("sha256").update(`${context.input.repoId}\0${runtimeSessionId}`).digest("hex"),
    opId = `runtime-cancel-${hash.slice(0, 32)}`;
  const headers = readDispatchStreamHeaders(context.input.rootDir),
    matchingHeader = headers.find((header) => header.runtimeSessionId === runtimeSessionId),
    missingOwnedProcess =
      matchingHeader !== undefined &&
      matchingHeader.binding !== undefined &&
      ownedByRuntimeNode(matchingHeader.binding, context.input.runtimeNodeId) &&
      !readDispatchStreamSummary(context.input.rootDir, matchingHeader.dispatchId)?.process;
  if (!context.processes.has(runtimeSessionId) && !missingOwnedProcess) await adoptRuntimes(context);
  const active = context.processes.get(runtimeSessionId);
  if (active) {
    active.cancelBinding = binding;
    active.cancelOpId = opId;
    active.cancelRequested = true;
    await consumeDurableOutput(context, active, cancelDurableDrainTimeoutMs);
    if (active.process.terminateTree) await active.process.terminateTree();
    else active.process.terminate();
    // Cancel holds the write queue: lines flushed during termination drain into work queued behind
    // it, which is dropped once settlement retires the runtime. Settle them from the stream.
    await consumeDurableOutput(context, active);
    await context.publishExit(active, null);
    return context.controlReceipt(opId, runtimeSessionId);
  }
  // A session with a dispatch record belongs to adoption above; only a session the projection
  // knows without any dispatch record is settled from the projection alone.
  const recorded = headers.some((header) => header.runtimeSessionId === runtimeSessionId),
    session =
      recorded && !missingOwnedProcess
        ? undefined
        : (context.input.remote
            ? await context.input.remote.readRuntimeSessions()
            : context.requiredRuntimeProjection(context.input).readRuntimeSessions()
          ).find((value) => value.runtimeSessionId === runtimeSessionId);
  if (session && session.liveness !== "exited" && session.outcome === null) {
    const terminalBinding = {
      ...binding,
      actor: {
        principal: binding.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
    };
    await context.publishRuntimeEvent("runtime_session_cancelled", { runtimeSessionId }, `${opId}-cancelled`, binding);
    await context.publishRuntimeEvent(
      "runtime_session_exited",
      { runtimeSessionId },
      `${opId}-exited`,
      terminalBinding,
    );
    await context.publishRuntimeEvent(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId,
        outcome: "cancelled",
        exitCode: null,
        resultRef: `artifact:runtime-result/sha256/${createHash("sha256").update(runtimeSessionId).digest("hex")}`,
        result: null,
        reasonCode: "runtime_process_missing",
      },
      `${opId}-outcome`,
      terminalBinding,
      "Runtime session cancelled after its worker process was no longer available.",
    );
    return context.controlReceipt(opId, runtimeSessionId, "cancelled");
  }
  return context.controlReceipt(opId, runtimeSessionId, "already-exited");
}

export function closeRuntimes(context: RuntimeSpawnerContext): void {
  const active = [...context.processes.values()];
  context.processes.clear();
  for (const entry of active) entry.process.release?.();
}
