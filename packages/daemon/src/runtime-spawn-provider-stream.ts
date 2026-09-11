import { setTimeout as delay } from "node:timers/promises";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SessionIdentity } from "../../kernel/src/index.ts";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { readDispatchStream, scrubProviderValue } from "./dispatch-stream.ts";
import type { ActiveRuntime, ProviderFrame, RuntimeBinding } from "./runtime-spawn-types.ts";
import { transcriptRefForSessionIdentity } from "./session-identity/index.ts";
import { observeProviderFault } from "./runtime-provider-fault.ts";
import {
  runtimeEventHasType,
  type RuntimeEventOf,
  type RuntimeEventPublication,
  type RuntimeEventType,
  type RuntimeSpawnerContext,
} from "./runtime-spawn-context.ts";

export async function publishRuntimeEvent<T extends RuntimeEventType>(
  context: RuntimeSpawnerContext,
  type: T,
  payload: RuntimeEventOf<T>["payload"],
  opId: string,
  binding: RuntimeBinding,
  resultBody?: string,
): Promise<RuntimeEventPublication<T>> {
  const authorizedBinding = context.input.authorizeRuntimeEvent?.({ type, payload, opId, binding }) ?? binding,
    published = context.input.remote
      ? await context.input.remote.publish({
          type,
          payload,
          opId,
          ...(resultBody === undefined ? {} : { resultBody }),
        })
      : context.input.commitRuntimeEvent
        ? await context.input.commitRuntimeEvent(
            {
              type,
              payload,
              opId,
              ...(resultBody === undefined ? {} : { resultBody }),
            },
            authorizedBinding,
          )
        : (() => {
            throw context.runtimeSpawnError(
              "runtime_preconditions_unavailable",
              "Local runtime event commit is unavailable.",
            );
          })();
  if (!published.event) {
    throw context.runtimeSpawnError(
      typeof published.receipt.code === "string" ? published.receipt.code : "runtime_event_rejected",
      `RuntimeSession Action ${type} was ${String(published.receipt.outcome ?? "rejected")}.`,
    );
  }
  if (!runtimeEventHasType(published.event, type))
    throw context.runtimeSpawnError("invalid_runtime_event", "Runtime publication changed the event type.");
  return { ...published, event: published.event };
}

export async function consumeProviderChunk(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  chunk: string,
  flush: boolean,
  persisted = false,
): Promise<void> {
  active.buffer += chunk;
  const lines = active.buffer.split(/\r?\n/u);
  const trailing = lines.pop() ?? "";
  active.buffer = flush ? "" : trailing;
  for (const line of lines) if (line.trim()) await context.consumeLine(active, line, persisted);
  if (flush && trailing.trim()) await context.consumeLine(active, trailing, persisted);
  if (flush) observeCodexSessionMetrics(context, active);
}

export async function consumeProviderLine(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  line: string,
  persisted = false,
  publishSignals = true,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(line);
    if (!persisted) active.stream.appendProviderEvent(value, context.input.now());
    active.durableOutputCount += 1;
  } catch (error) {
    if (persisted) active.durableOutputCount += 1;
    consumeKnownError(error);
    context.markProtocolError(active);
    return;
  }
  observeRuntimeMetrics(active, value);
  let parsed: ProviderFrame;
  try {
    parsed = context.parseProviderFrame(active.kindId, scrubProviderValue(value) as Record<string, unknown>);
  } catch (error) {
    consumeKnownError(error);
    context.markProtocolError(active);
    return;
  }
  if (parsed.sessionIdentity?.sessionId) await context.bindProvider(active, parsed.sessionIdentity);
  if (publishSignals)
    for (const signal of parsed.signals ?? []) context.input.stream.publish(active.runtimeSessionId, signal);
  if (parsed.finalText !== undefined) active.finalText = parsed.finalText;
  if (parsed.failureText !== undefined) active.failureText = parsed.failureText;
  if (parsed.outcome) active.providerOutcome = parsed.outcome;
  active.writeItemObserved ||= parsed.writeItemObserved === true;
  active.planObserved ||=
    parsed.planObserved === true ||
    (parsed.finalText !== undefined && context.isStructuredSuccessResult(parsed.finalText));
  if (parsed.planIncomplete !== undefined) active.planIncomplete = parsed.planIncomplete;
  observeProviderFault(active, parsed);
}

function observeRuntimeMetrics(active: ActiveRuntime, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const frame = value as Record<string, unknown>,
    nestedMessage =
      frame.message && typeof frame.message === "object" && !Array.isArray(frame.message)
        ? (frame.message as Record<string, unknown>)
        : null,
    usageValue = frame.usage ?? nestedMessage?.usage,
    usage =
      usageValue && typeof usageValue === "object" && !Array.isArray(usageValue)
        ? (usageValue as Record<string, unknown>)
        : null;
  if (usage) {
    active.rawUsage = { ...active.rawUsage, ...usage };
    const input = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0;
    const cacheRead = numberValue(usage.cached_input_tokens) ?? numberValue(usage.cache_read_input_tokens) ?? 0;
    const cacheCreation = numberValue(usage.cache_creation_input_tokens) ?? 0;
    active.inputTokens += input + (numberValue(usage.cache_read_input_tokens) !== null ? cacheRead + cacheCreation : 0);
    active.cacheReadTokens += cacheRead;
    active.outputTokens += numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0;
  }
  const type = String(frame.type ?? frame.event ?? "").toLowerCase();
  if (type.includes("compaction") || type.includes("context_truncated") || frame.compacted === true)
    active.compacted = true;
  if (type === "assistant" && frame.message && typeof frame.message === "object" && !Array.isArray(frame.message)) {
    const content = (frame.message as Record<string, unknown>).content;
    if (Array.isArray(content))
      active.toolCallCount += content.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          ["tool_use", "server_tool_use"].includes(String((item as Record<string, unknown>).type)),
      ).length;
  }
  if (type === "item.completed" || type === "item.updated") {
    const item = frame.item;
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(
        String((item as Record<string, unknown>).type),
      )
    )
      active.toolCallCount += 1;
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function observeCodexSessionMetrics(context: RuntimeSpawnerContext, active: ActiveRuntime): void {
  if (
    active.kindId !== "codex" ||
    !active.providerUsageEmpty ||
    active.providerSessionId === null ||
    !/^[a-z0-9-]+$/iu.test(active.providerSessionId)
  )
    return;
  const userRoot = context.input.runtimeDaemonRoute?.userRoot;
  if (!userRoot) return;
  const sessionsRoot = path.join(userRoot, "runtime-instances", active.instanceId, "home", ".codex", "sessions"),
    matches = globSync(`**/rollout-*-${active.providerSessionId}.jsonl`, { cwd: sessionsRoot });
  if (matches.length !== 1) return;
  let lines: string[];
  try {
    lines = readFileSync(path.join(sessionsRoot, matches[0]!), "utf8").split(/\r?\n/u);
  } catch (error) {
    consumeKnownError(error);
    return;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record: unknown = JSON.parse(lines[index]!);
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const payload = (record as Record<string, unknown>).payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const info = (payload as Record<string, unknown>).info;
      if ((payload as Record<string, unknown>).type !== "token_count" || !providerRecord(info)) continue;
      const usage = providerRecord(info.last_token_usage) ? info.last_token_usage : null;
      if (!usage) continue;
      const input = numberValue(usage.input_tokens),
        cached = numberValue(usage.cached_input_tokens),
        output = numberValue(usage.output_tokens);
      if (input === null || cached === null || output === null) return;
      active.inputTokens = input;
      active.cacheReadTokens = cached;
      active.outputTokens = output;
      active.rawUsage = { ...usage };
      return;
    } catch (error) {
      consumeKnownError(error);
    }
  }
}

function providerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function consumeDurableOutput(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  waitForFirstRecordMs = 0,
): Promise<void> {
  let stream = readDispatchStream(context.input.rootDir, active.dispatchId);
  let records = durableOutputRecords(stream?.records ?? []);
  const deadline = Date.now() + waitForFirstRecordMs;
  while (records.length === 0 && stream?.process?.exited === false && Date.now() < deadline) {
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    stream = readDispatchStream(context.input.rootDir, active.dispatchId);
    records = durableOutputRecords(stream?.records ?? []);
  }
  for (const record of records.slice(active.durableOutputCount)) {
    await context.consumeLine(
      active,
      record.kind === "provider_event" ? JSON.stringify(record.event) : String(record.output),
      true,
    );
  }
}

export async function restoreDurableOutputRecords(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  records: readonly Record<string, unknown>[],
): Promise<number> {
  const durable = durableOutputRecords(records);
  for (const record of durable) {
    await context.consumeLine(
      active,
      record.kind === "provider_event" ? JSON.stringify(record.event) : String(record.output),
      true,
      false,
    );
  }
  return durable.length;
}

export function durableOutputRecordCount(records: readonly Record<string, unknown>[]): number {
  return durableOutputRecords(records).length;
}

function durableOutputRecords(records: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return records.filter((record) => record.kind === "provider_event" || record.kind === "provider_output_invalid");
}

export function captureErrorOutput(context: RuntimeSpawnerContext, active: ActiveRuntime, chunk: string): void {
  if (active.errorOverflowed || context.processes.get(active.runtimeSessionId) !== active) return;
  active.errorBuffer += chunk;
  if (Buffer.byteLength(active.errorBuffer) > context.providerErrorLimit) {
    active.errorBuffer = "";
    active.errorOverflowed = true;
  }
}

export async function bindProvider(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  identity: SessionIdentity,
): Promise<void> {
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
        taskId: active.task.taskId,
        executionId: active.task.executionId,
        providerSessionId,
        transcriptRef,
      },
      `${active.dispatchOpId}-task`,
      active.binding,
    );
}

export function markProtocolError(context: RuntimeSpawnerContext, active: ActiveRuntime): void {
  if (active.protocolError) return;
  active.protocolError = true;
  context.input.stream.publish(active.runtimeSessionId, {
    type: "error",
    code: "provider_protocol_error",
  });
}
