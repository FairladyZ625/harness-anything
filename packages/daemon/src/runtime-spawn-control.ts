import { createHash } from "node:crypto";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { adoptRuntimes, ownedByRuntimeSpawner } from "./runtime-spawn-adoption.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";

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
  // Terminal streams retain their owner binding after archival; repeated cancellation still verifies it.
  const headers = readDispatchStreamHeaders(context.input.rootDir, true),
    matchingHeader = headers.find((header) => header.runtimeSessionId === runtimeSessionId),
    missingOwnedProcess =
      matchingHeader !== undefined &&
      matchingHeader.binding !== undefined &&
      ownedByRuntimeSpawner(matchingHeader.binding, context.input.runtimeNode) &&
      !readDispatchStreamSummary(context.input.rootDir, matchingHeader.dispatchId)?.process;
  if (!matchingHeader?.binding || !ownedByRuntimeSpawner(matchingHeader.binding, context.input.runtimeNode))
    throw runtimeSpawnError(
      "execution_scope_mismatch",
      "This runtime has no owner dispatch on this node; cancel it through its owner.",
    );
  if (!context.processes.has(runtimeSessionId) && !missingOwnedProcess) {
    const [adoption] = await Promise.allSettled([adoptRuntimes(context)]);
    if (adoption.status === "rejected" && !context.processes.has(runtimeSessionId)) throw adoption.reason;
  }
  const active = context.processes.get(runtimeSessionId);
  if (active) {
    active.cancelBinding = binding;
    active.cancelOpId = opId;
    active.cancelRequested = true;
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
    const resultBody = "Runtime session cancelled after its worker process was no longer available.",
      resultSha256 = createHash("sha256").update(resultBody).digest("hex");
    await context.publishRuntimeEvent(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId,
        outcome: "cancelled",
        exitCode: null,
        resultRef: `artifact:runtime-result/sha256/${resultSha256}`,
        result: { sha256: resultSha256, size: Buffer.byteLength(resultBody), mediaType: "text/plain; charset=utf-8" },
        reasonCode: "runtime_process_missing",
      },
      `${opId}-outcome`,
      terminalBinding,
      resultBody,
    );
    return context.controlReceipt(opId, runtimeSessionId, "cancelled");
  }
  return context.controlReceipt(opId, runtimeSessionId, "already-exited");
}

export async function steerRuntime(
  context: RuntimeSpawnerContext,
  payload: JsonObject,
  binding: RuntimeBinding,
): Promise<JsonObject> {
  const unknownField = unknownFieldViolation(payload, ["runtimeSessionId", "dispatchId", "prompt"]);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_steer", `Runtime steer payload contains an ${unknownField}`);
  const runtimeSessionIdInput = payload.runtimeSessionId,
    dispatchIdInput = payload.dispatchId,
    prompt = requiredRuntimeSpawnText(payload.prompt, "prompt");
  if ((typeof runtimeSessionIdInput === "string") === (typeof dispatchIdInput === "string"))
    throw runtimeSpawnError("invalid_runtime_steer", "Specify exactly one runtime session id or dispatch id.");
  const headers = readDispatchStreamHeaders(context.input.rootDir);
  let header = headers.find((entry) =>
    typeof dispatchIdInput === "string"
      ? entry.dispatchId === dispatchIdInput
      : entry.runtimeSessionId === runtimeSessionIdInput,
  );
  if (!header) throw runtimeSpawnError("runtime_not_running", "Runtime dispatch was not found.");
  if (typeof dispatchIdInput === "string" && header.taskId === null) {
    // A taskless conversation addressed by its first dispatch steers the current leaf round:
    // an earlier round's process has exited by the time a later round runs, and only the leaf
    // can be live. Task-bound dispatches keep direct addressing.
    const seen = new Set([header.dispatchId]);
    let current = header;
    for (;;) {
      const child = headers.find((entry) => entry.resumedFromDispatchId === current.dispatchId);
      if (!child || seen.has(child.dispatchId)) break;
      seen.add(child.dispatchId);
      current = child;
    }
    header = current;
  }
  const runtimeSessionId = header.runtimeSessionId;
  if (!header?.binding || !ownedByRuntimeSpawner(header.binding, context.input.runtimeNode))
    throw runtimeSpawnError("execution_scope_mismatch", "This runtime is owned by another node.");
  let active = context.processes.get(runtimeSessionId);
  if (!active) {
    await adoptRuntimes(context);
    active = context.processes.get(runtimeSessionId);
  }
  if (!active) throw runtimeSpawnError("runtime_not_running", "Runtime is not running.");
  if (!runtimeKindForId(active.kindId).steer)
    throw runtimeSpawnError("runtime_steer_unsupported", `${active.kindId} does not support runtime steering.`);
  if (!active.providerSessionId)
    throw runtimeSpawnError("runtime_steer_unavailable", "Provider has not established a resumable session yet.");
  // A recorded request nobody follows is not an applied steer: the host is the only reader of
  // this stream, and a host that is gone cannot be steered back. Settlement retires the runtime,
  // but the window before it does would otherwise report success into an empty room.
  if (!runtimePidIsAlive(active.process.pid))
    throw runtimeSpawnError("runtime_steer_unavailable", "Runtime control channel is unavailable.");
  const opId = `runtime-steer-${createHash("sha256").update(`${context.input.repoId}\0${runtimeSessionId}\0${context.input.now()}\0${prompt}`).digest("hex").slice(0, 32)}`;
  // The dispatch stream is the control channel: the worker host owning the provider follows
  // this file, so a host adopted after a daemon restart is steered like one this daemon spawned.
  appendRuntimeWorkerRecord(context.input.rootDir, header.dispatchId, {
    kind: "steer_requested",
    opId,
    runtimeSessionId,
    occurredAt: context.input.now(),
    actor: binding.actor,
    source: binding.source,
    prompt,
  });
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-steer",
    outcome: "applied",
    opId,
    runtimeSessionId,
    dispatchId: header.dispatchId,
    // A steer's only durable effect is the dispatch-stream record written above; it appends no
    // ledger event, so it has no command outcome to accept. Declaring the determinate no-write
    // here keeps the receipt applied instead of being re-judged as acceptance_unknown, which
    // shipped `ok:true` with `outcome:indeterminate` and failed the GUI receipt exit.
    status: "settled_no_write",
    visibility: "center",
    evidence: `dispatch-stream:${header.dispatchId}:steer_requested:${opId}`,
  };
}

export function closeRuntimes(context: RuntimeSpawnerContext): void {
  const active = [...context.processes.values()];
  context.processes.clear();
  for (const entry of active) entry.process.release?.();
}
