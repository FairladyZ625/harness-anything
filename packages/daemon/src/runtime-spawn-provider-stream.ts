import { createHash } from "node:crypto";
import type {
  AgentRuntimeEventV1,
  CanonicalContentBlob,
  CanonicalEventStore,
  SessionIdentity,
} from "../../kernel/src/index.ts";
import { canonicalEventWritePlan, consumeKnownError } from "../../kernel/src/index.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import type { ActiveRuntime, ProviderFrame, RuntimeBinding } from "./runtime-spawn-types.ts";
import { transcriptRefForSessionIdentity } from "./session-identity/index.ts";

export async function publishRuntimeEvent<T extends AgentRuntimeEventV1["type"]>(
  context: any,
  type: T,
  payload: AgentRuntimeEventV1["payload"],
  opId: string,
  binding: RuntimeBinding,
  resultBody?: string,
): Promise<{
  readonly event: AgentRuntimeEventV1;
  readonly publication?: ReturnType<CanonicalEventStore["append"]>;
  readonly receipt?: JsonObject;
}> {
  if (context.input.remote)
    return context.input.remote.publish({
      type,
      payload,
      opId,
      ...(resultBody === undefined ? {} : { resultBody }),
    });
  const store = context.requiredRuntimeStore(context.input),
    projection = context.requiredRuntimeProjection(context.input),
    value = {
      schema: "agent-runtime-event/v1",
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
      opId,
      type,
      actor: binding.actor,
      source: binding.source,
      occurredAt: context.input.now(),
      payload,
    } as AgentRuntimeEventV1;
  let blobs: readonly CanonicalContentBlob[] = [];
  if (resultBody !== undefined) {
    if (value.type !== "runtime_session_outcome_observed")
      throw context.runtimeSpawnError("invalid_runtime_event", "Only a runtime outcome can carry result bytes.");
    blobs = [{ ...value.payload.result, body: resultBody }];
  }
  const appended = store.append({
    event: value,
    plan: canonicalEventWritePlan(value, "agent-runtime/v1", value.opId),
    blobs,
  });
  projection.apply(value);
  return { event: value, publication: appended };
}

export async function consumeChunk(context: any, active: ActiveRuntime, chunk: string, flush: boolean): Promise<void> {
  active.buffer += chunk;
  const lines = active.buffer.split(/\r?\n/u);
  active.buffer = flush ? "" : (lines.pop() ?? "");
  for (const line of lines) if (line.trim()) await context.consumeLine(active, line);
  if (flush && active.buffer.trim()) await context.consumeLine(active, active.buffer);
}

export async function consumeLine(context: any, active: ActiveRuntime, line: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(line);
    active.stream.appendProviderEvent(value, context.input.now());
  } catch (error) {
    consumeKnownError(error);
    context.markProtocolError(active);
    return;
  }
  let parsed: ProviderFrame;
  try {
    parsed = context.parseProviderFrame(active.kindId, scrubProviderValue(value) as Record<string, unknown>);
  } catch (error) {
    consumeKnownError(error);
    context.markProtocolError(active);
    return;
  }
  if (parsed.sessionIdentity?.sessionId) await context.bindProvider(active, parsed.sessionIdentity);
  for (const signal of parsed.signals ?? []) context.input.stream.publish(active.runtimeSessionId, signal);
  if (parsed.finalText !== undefined) active.finalText = parsed.finalText;
  if (parsed.failureText !== undefined) active.failureText = parsed.failureText;
  if (parsed.outcome) active.providerOutcome = parsed.outcome;
  active.writeItemObserved ||= parsed.writeItemObserved === true;
  active.planObserved ||=
    parsed.planObserved === true ||
    (parsed.finalText !== undefined && context.isStructuredSuccessResult(parsed.finalText));
  if (parsed.planIncomplete !== undefined) active.planIncomplete = parsed.planIncomplete;
}

export function captureErrorOutput(context: any, active: ActiveRuntime, chunk: string): void {
  if (active.errorOverflowed || context.processes.get(active.runtimeSessionId) !== active) return;
  active.errorBuffer += chunk;
  if (Buffer.byteLength(active.errorBuffer) > context.providerErrorLimit) {
    active.errorBuffer = "";
    active.errorOverflowed = true;
  }
}

export async function bindProvider(context: any, active: ActiveRuntime, identity: SessionIdentity): Promise<void> {
  const providerSessionId = identity.sessionId;
  if (
    providerSessionId === null ||
    (active.resumeProviderSessionId !== null && active.resumeProviderSessionId !== providerSessionId)
  ) {
    context.markProtocolError(active);
    return;
  }
  if (active.providerSessionId === providerSessionId) return;
  if (active.providerSessionId !== null) {
    context.markProtocolError(active);
    return;
  }
  const transcriptRef = transcriptRefForSessionIdentity(identity, active.stream.ref);
  if (transcriptRef === null) {
    context.markProtocolError(active);
    return;
  }
  active.providerSessionId = providerSessionId;
  active.stream.appendProviderBinding(providerSessionId, context.input.now());
  await context.publishRuntimeEvent(
    "runtime_session_provider_bound",
    {
      runtimeSessionId: active.runtimeSessionId,
      providerSessionId,
      transcriptRef,
    },
    `${active.dispatchOpId}-provider`,
    active.binding,
  );
  if (active.task)
    await context.publishRuntimeEvent(
      "runtime_session_task_bound",
      {
        runtimeSessionId: active.runtimeSessionId,
        ...active.task,
        providerSessionId,
        transcriptRef,
      },
      `${active.dispatchOpId}-task`,
      active.binding,
    );
}

export function markProtocolError(context: any, active: ActiveRuntime): void {
  if (active.protocolError) return;
  active.protocolError = true;
  context.input.stream.publish(active.runtimeSessionId, {
    type: "error",
    code: "provider_protocol_error",
  });
}

export function terminateActive(context: any, active: ActiveRuntime, cancelled: boolean): void {
  if (cancelled) active.cancelRequested = true;
  active.process.terminate();
}
