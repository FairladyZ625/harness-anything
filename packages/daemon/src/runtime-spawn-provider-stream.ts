import { setTimeout as delay } from "node:timers/promises";
import { globSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { SessionIdentity } from "../../kernel/src/index.ts";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { dispatchStreamPath, parseRecord, readDispatchStreamIncrement, scrubProviderValue } from "./dispatch-stream.ts";
import { observeRuntimeModels } from "./agent-runtime-installation-discovery.ts";
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
  // ACP session frames carry the provider's advertised model catalog; merge it
  // into the installation catalog cache so refresh surfaces it like a CLI probe.
  if (parsed.observedModels?.length && active.installation)
    observeRuntimeModels({
      kindId: active.kindId,
      executablePath: active.installation.executablePath,
      version: active.installation.version,
      models: parsed.observedModels,
      ...(parsed.observedCurrentModel ? { currentModel: parsed.observedCurrentModel } : {}),
    });
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
    // ACP frames rename usage fields (input/output/total/used) because the
    // dispatch-stream scrubber drops every key containing "token".
    const input = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? numberValue(usage.input),
      cacheRead = numberValue(usage.cached_input_tokens) ?? numberValue(usage.cache_read_input_tokens),
      cacheCreation = numberValue(usage.cache_creation_input_tokens),
      output = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? numberValue(usage.output),
      total =
        numberValue(usage.total_tokens) ??
        numberValue(usage.totalTokens) ??
        numberValue(usage.total) ??
        numberValue(usage.used);
    if (input !== null || cacheRead !== null || cacheCreation !== null || output !== null || total !== null)
      active.usageReported = true;
    active.inputTokens +=
      (input ?? 0) +
      (numberValue(usage.cache_read_input_tokens) !== null ? (cacheRead ?? 0) + (cacheCreation ?? 0) : 0);
    active.cacheReadTokens += cacheRead ?? 0;
    active.outputTokens += output ?? 0;
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
  // AGY reports each tool step twice (ACTIVE then DONE); step_index is the stable step identity.
  if (type === "step_update" && providerRecord(frame.step_update)) {
    const update = frame.step_update;
    if (update.step_type === "tool" && Number.isInteger(update.step_index)) {
      const key = `${String(update.conversation_id ?? "")}:${String(update.step_index)}`;
      if (!active.providerToolSteps.has(key)) {
        active.providerToolSteps.add(key);
        active.toolCallCount += 1;
      }
    }
  }
  // ZCode settles each turn's tool count in turn.completed.payload; per-turn values accumulate.
  if (type === "turn.completed" && providerRecord(frame.payload)) {
    const turnToolCalls = numberValue(frame.payload.toolCallCount);
    if (turnToolCalls !== null) active.toolCallCount += turnToolCalls;
  }
  // ACP tool calls announce once per toolCallId; later tool_call_update rows are status churn.
  if (type === "acp.update" && providerRecord(frame.update) && frame.update.sessionUpdate === "tool_call") {
    const key = `acp:${String(frame.update.toolCallId ?? "")}`;
    if (!active.providerToolSteps.has(key)) {
      active.providerToolSteps.add(key);
      active.toolCallCount += 1;
    }
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
  const lines = readFileSync(path.join(sessionsRoot, matches[0]!), "utf8").split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes('"token_count"')) continue;
    const record: unknown = JSON.parse(line);
    if (!providerRecord(record) || !providerRecord(record.payload)) continue;
    const { payload } = record;
    if (payload.type !== "token_count" || !providerRecord(payload.info)) continue;
    const usage = providerRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : null;
    if (!usage) continue;
    const input = numberValue(usage.input_tokens),
      cached = numberValue(usage.cached_input_tokens),
      output = numberValue(usage.output_tokens);
    if (input === null || cached === null || output === null) return;
    active.inputTokens = input;
    active.cacheReadTokens = cached;
    active.outputTokens = output;
    active.rawUsage = { ...usage };
    active.usageReported = true;
    return;
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
  const target = dispatchStreamPath(context.input.rootDir, active.dispatchId),
    deadline = Date.now() + waitForFirstRecordMs,
    pending: string[] = [],
    decoder = new StringDecoder("utf8");
  let durableSeen = 0,
    workerRunning = false,
    offset = 0,
    tail = "";
  const scan = (): void => {
    const next = readDispatchStreamIncrement(target, offset);
    if (next === null || next.bytes.length === 0) return;
    offset += next.bytes.length;
    tail += decoder.write(next.bytes);
    const lines = tail.split(/\r?\n/u);
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseRecord(line);
      if (record?.kind === "process_started") workerRunning = true;
      else if (record?.kind === "process_exit") workerRunning = false;
      else if (record?.kind === "provider_event" || record?.kind === "provider_output_invalid") {
        durableSeen += 1;
        if (durableSeen > active.durableOutputCount)
          pending.push(record.kind === "provider_event" ? JSON.stringify(record.event) : String(record.output));
      }
    }
  };
  scan();
  while (durableSeen === 0 && workerRunning && Date.now() < deadline) {
    await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    scan();
  }
  for (const line of pending) await context.consumeLine(active, line, true);
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
