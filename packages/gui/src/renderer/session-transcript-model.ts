import { clip, recordOf, stringOf } from "./daemon-observe-model.ts";

export type SessionTranscriptItemType = "thinking" | "tool_call" | "tool_result" | "text" | "error";

export interface SessionTranscriptItem {
  readonly key: string;
  readonly type: SessionTranscriptItemType;
  readonly label: string;
  readonly summary: string;
  readonly detail: string;
  readonly occurredAt: string | null;
  /** provider 侧工具调用 id(Claude tool_use/zcode toolCallId/acp toolCallId/codex itemId);无 id 的协议省略,聚合按名字顺序配对。 */
  readonly toolCallId?: string;
}

export interface SessionTranscriptTurn {
  readonly key: string;
  readonly status: "running" | "completed" | "failed" | "unknown";
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly items: readonly SessionTranscriptItem[];
}

type MutableTurn = {
  key: string;
  status: SessionTranscriptTurn["status"];
  startedAt: string | null;
  endedAt: string | null;
  items: SessionTranscriptItem[];
};

const DETAIL_LIMIT = 8_000;

/** Persisted provider events from all three runtime adapters become one chronological turn timeline. */
export function sessionTranscriptTurns(
  records: readonly Readonly<Record<string, unknown>>[],
): readonly SessionTranscriptTurn[] {
  const turns: MutableTurn[] = [],
    byKey = new Map<string, MutableTurn>(),
    toolTurns = new Map<string, { readonly turn: MutableTurn; readonly label: string }>(),
    codexTools = new Map<string, { readonly turn: MutableTurn; readonly label: string }>();
  let current: MutableTurn | null = null,
    codexIndex = 0,
    itemIndex = 0;

  const turn = (key: string, at: string | null): MutableTurn => {
      const known = byKey.get(key);
      if (known) return known;
      const created: MutableTurn = { key, status: "unknown", startedAt: at, endedAt: null, items: [] };
      byKey.set(key, created);
      turns.push(created);
      return created;
    },
    add = (
      target: MutableTurn,
      type: SessionTranscriptItemType,
      label: string,
      detail: string,
      at: string | null,
      appendDelta = false,
      toolCallId?: string,
    ) => {
      const normalized = clip(appendDelta ? detail : detail.trim(), DETAIL_LIMIT),
        prior = target.items.at(-1);
      if (!normalized) return;
      if (prior && prior.type === type && (type === "thinking" || type === "text")) {
        const combined = `${prior.detail}${appendDelta ? "" : "\n\n"}${normalized}`;
        target.items[target.items.length - 1] = {
          ...prior,
          summary: summaryOf(combined),
          detail: clip(combined, DETAIL_LIMIT),
          occurredAt: at ?? prior.occurredAt,
        };
        return;
      }
      target.items.push({
        key: `${target.key}:${itemIndex++}`,
        type,
        label,
        summary: summaryOf(normalized),
        detail: normalized,
        occurredAt: at,
        ...(toolCallId ? { toolCallId } : {}),
      });
    };

  for (const record of records) {
    const at = stringOf(record.occurredAt) ?? stringOf(record.at);
    if (record.kind === "provider_event") {
      const event = recordOf(record.event);
      if (!event) continue;
      const type = stringOf(event.type);
      if (type === "assistant" || type === "user") {
        const message = recordOf(event.message),
          messageId = stringOf(message?.id),
          content = Array.isArray(message?.content) ? message.content.map(recordOf).filter(isPresent) : [];
        if (type === "assistant") {
          const next = turn(`message:${messageId ?? turns.length}`, at);
          if (current && current !== next && current.key.startsWith("message:") && current.status === "running") {
            current.status = "completed";
            current.endedAt = at;
          }
          current = next;
          if (current.status === "unknown") current.status = "running";
        }
        for (const part of content) {
          const partType = stringOf(part.type);
          if (partType === "tool_result" || partType === "web_search_tool_result") {
            const toolId = stringOf(part.tool_use_id),
              known = toolId ? toolTurns.get(toolId) : null,
              target = known?.turn ?? current ?? turn("provider:1", at),
              label = known?.label ?? (toolId ? `tool ${toolId}` : "tool");
            add(target, "tool_result", label, contentOf(part.content ?? part), at, false, toolId ?? undefined);
            current = target;
            continue;
          }
          const target = current ?? turn(`message:${messageId ?? turns.length}`, at);
          if (partType === "thinking") add(target, "thinking", "thinking", stringOf(part.thinking) ?? "", at);
          else if (partType === "text") add(target, "text", "text", stringOf(part.text) ?? "", at);
          else if (partType === "tool_use" || partType === "server_tool_use") {
            const toolId = stringOf(part.id),
              label = stringOf(part.name) ?? "tool";
            add(target, "tool_call", label, contentOf(part.input ?? part), at, false, toolId ?? undefined);
            if (toolId) toolTurns.set(toolId, { turn: target, label });
          } else if (partType === "web_search_tool_result")
            add(target, "tool_result", "web search", contentOf(part), at);
        }
        continue;
      }
      if (type === "turn.started") {
        current = turn(`codex:${++codexIndex}`, at);
        current.status = "running";
        continue;
      }
      if (type === "turn.completed" || type === "turn.failed") {
        current ??= turn(`codex:${++codexIndex}`, at);
        current.status = type === "turn.failed" ? "failed" : "completed";
        current.endedAt = at;
        continue;
      }
      if (type === "item.started" || type === "item.completed" || type === "item.updated") {
        current ??= turn(`codex:${++codexIndex}`, at);
        const item = recordOf(event.item),
          itemType = stringOf(item?.type),
          itemId = stringOf(item?.id);
        if (!item) continue;
        if (itemType === "agent_message") add(current, "text", "text", stringOf(item.text) ?? "", at);
        else if (itemType === "reasoning")
          add(current, "thinking", "thinking", stringOf(item.text) ?? contentOf(item), at);
        else if (["command_execution", "mcp_tool_call", "web_search"].includes(itemType ?? "")) {
          const label = toolLabel(item);
          if (type === "item.started") {
            add(current, "tool_call", label, toolInput(item), at, false, itemId ?? undefined);
            if (itemId) codexTools.set(itemId, { turn: current, label });
          } else {
            const known = itemId ? codexTools.get(itemId) : null,
              target = known?.turn ?? current;
            if (!known) add(target, "tool_call", label, toolInput(item), at, false, itemId ?? undefined);
            add(target, "tool_result", known?.label ?? label, toolOutput(item), at, false, itemId ?? undefined);
          }
        } else if (itemType === "file_change") add(current, "tool_result", "file change", contentOf(item), at);
        else if (itemType === "error") add(current, "error", "error", contentOf(item), at);
        continue;
      }
      if (type === "model.streaming") {
        current ??= turn(`zcode:${stringOf(event.turnId) ?? turns.length + 1}`, at);
        if (current.status === "unknown") current.status = "running";
        const payload = recordOf(event.payload),
          kind = stringOf(payload?.kind),
          delta = stringOf(payload?.delta) ?? "";
        if (kind === "reasoning_delta") add(current, "thinking", "thinking", delta, at, true);
        else if (kind === "text_delta") add(current, "text", "text", delta, at, true);
        else if (kind === "tool_call" && payload) {
          const toolId = stringOf(payload.toolCallId),
            label = stringOf(payload.toolName) ?? "tool";
          add(current, "tool_call", label, contentOf(payload.input ?? payload), at, false, toolId ?? undefined);
          if (toolId) toolTurns.set(toolId, { turn: current, label });
        }
        continue;
      }
      if (type === "tool.updated") {
        const payload = recordOf(event.payload),
          kind = stringOf(payload?.kind),
          toolId = stringOf(payload?.toolCallId),
          known = toolId ? toolTurns.get(toolId) : null,
          target = known?.turn ?? current ?? turn(`zcode:${stringOf(event.turnId) ?? turns.length + 1}`, at),
          label = known?.label ?? (toolId ? `tool ${toolId}` : "tool");
        current = target;
        if (kind === "result" && payload)
          add(target, "tool_result", label, contentOf(payload.result), at, false, toolId ?? undefined);
        else if (kind === "error" && payload)
          add(target, "error", label, contentOf(payload.error), at, false, toolId ?? undefined);
        continue;
      }
      if (type === "acp.update") {
        const update = recordOf(event.update);
        if (!update) continue;
        const sessionId = stringOf(event.sessionId) ?? "1";
        current ??= turn(`acp:${sessionId}`, at);
        if (current.status === "unknown") current.status = "running";
        const kind = stringOf(update.sessionUpdate);
        if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
          const content = recordOf(update.content);
          add(
            current,
            kind === "agent_thought_chunk" ? "thinking" : "text",
            kind === "agent_thought_chunk" ? "thinking" : "text",
            stringOf(content?.text) ?? "",
            at,
            true,
          );
        } else if (kind === "tool_call") {
          const toolId = stringOf(update.toolCallId),
            label = stringOf(update.title) ?? "tool";
          add(current, "tool_call", label, contentOf(update.rawInput ?? update), at, false, toolId ?? undefined);
          if (toolId) toolTurns.set(toolId, { turn: current, label });
        } else if (kind === "tool_call_update") {
          const status = stringOf(update.status);
          if (status !== "in_progress" && status !== "pending") {
            const toolId = stringOf(update.toolCallId),
              known = toolId ? toolTurns.get(toolId) : null,
              target = known?.turn ?? current,
              label = known?.label ?? (toolId ? `tool ${toolId}` : "tool"),
              parts = Array.isArray(update.content) ? update.content.map(recordOf).filter(isPresent) : [],
              output = parts
                .map((part) => stringOf(recordOf(part.content)?.text) ?? contentOf(part.content ?? part))
                .join("\n");
            if (status === "failed")
              add(target, "error", label, output || "tool call failed", at, false, toolId ?? undefined);
            else if (output) add(target, "tool_result", label, output, at, false, toolId ?? undefined);
            current = target;
          }
        }
        continue;
      }
      if (type === "acp.result") {
        const sessionId = stringOf(event.sessionId) ?? "1",
          finalText = stringOf(event.finalText) ?? "";
        current ??= turn(`acp:${sessionId}`, at);
        const lastTextIndex = current.items.map((item) => item.type).lastIndexOf("text"),
          lastText = lastTextIndex === -1 ? null : current.items[lastTextIndex];
        if (finalText && lastText?.label === "text")
          current.items[lastTextIndex] = {
            ...lastText,
            label: "result",
            summary: summaryOf(finalText),
            detail: clip(finalText, DETAIL_LIMIT),
            occurredAt: at ?? lastText.occurredAt,
          };
        else if (finalText && lastText?.detail !== finalText) add(current, "text", "result", finalText, at);
        current.status = ["end_turn", "max_tokens", "stop_sequence"].includes(stringOf(event.stopReason) ?? "")
          ? "completed"
          : "failed";
        current.endedAt = at;
        continue;
      }
      if (type === "acp.error") {
        const sessionId = stringOf(event.sessionId) ?? "1";
        current ??= turn(`acp:${sessionId}`, at);
        add(current, "error", "error", contentOf(event.error ?? event.message ?? event), at);
        continue;
      }
      if (type === "result") {
        current ??= turn(`provider:${turns.length + 1}`, at);
        const response = stringOf(event.response),
          result = stringOf(event.result) ?? response,
          prior = current.items.at(-1);
        if (response && prior?.type === "text" && prior.label === "text")
          current.items[current.items.length - 1] = {
            ...prior,
            label: "result",
            summary: summaryOf(response),
            detail: clip(response, DETAIL_LIMIT),
            occurredAt: at ?? prior.occurredAt,
          };
        else if (result && prior?.detail !== result) add(current, "text", "result", result, at);
        current.status = event.is_error === true ? "failed" : "completed";
        current.endedAt = at;
        continue;
      }
      if (event.event === "step_update") {
        const update = recordOf(event.step_update);
        if (!update) continue;
        current ??= turn("agy:1", at);
        if (current.status === "unknown") current.status = "running";
        const delta = stringOf(update.text_delta);
        if (delta) {
          add(current, "text", "text", delta, at, true);
          continue;
        }
        if (update.step_type === "tool") {
          const label = stringOf(update.tool_name) ?? "tool",
            info = recordOf(update.tool_info),
            output = info === null ? null : stringOf(info.output);
          // ACTIVE carries the parameters, DONE carries the same parameters plus the output.
          if (output !== null) add(current, "tool_result", label, output, at);
          else if (info !== null) add(current, "tool_call", label, contentOf(info.parameters ?? info), at);
        }
        continue;
      }
      if (event.event === "result") {
        const result = recordOf(event.result),
          response = result === null ? null : stringOf(result.response),
          prior = current?.items.at(-1);
        current ??= turn("agy:1", at);
        if (response && prior?.type === "text" && prior.label === "text")
          current.items[current.items.length - 1] = {
            ...prior,
            label: "result",
            summary: summaryOf(response),
            detail: clip(response, DETAIL_LIMIT),
            occurredAt: at ?? prior.occurredAt,
          };
        else if (response && prior?.detail !== response) add(current, "text", "result", response, at);
        current.status = result !== null && result.status === "SUCCESS" ? "completed" : "failed";
        current.endedAt = at;
        continue;
      }
      continue;
    }
    if (record.kind === "process_exit" || (record.kind === "exit_notification" && record.phase === "finished")) {
      current ??= turn("process:1", at);
      const exitCode = numberOf(record.exitCode),
        failed = exitCode !== null && exitCode !== 0;
      current.status = failed ? "failed" : "completed";
      current.endedAt = at;
      if (failed) add(current, "error", "process exit", `exit code ${exitCode}`, at);
    }
  }
  return turns.filter((entry) => entry.items.length > 0).map((entry) => ({ ...entry, items: [...entry.items] }));
}

// ---- 工具调用聚合 / 计划步骤 / Steering 待注入队列(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3) ----

export type ToolCallStatus = "running" | "succeeded" | "failed";

/** 单次工具调用:ToolCallCard/ToolCallGroup 视图原语(W1-T3)的消费契约字段。 */
export type ToolCallEntry = {
  readonly key: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ToolCallStatus;
  /** call→result 的时间差;任一端时间未知为 null,不虚构。 */
  readonly durationMs: number | null;
  readonly args: string;
  readonly result: string | null;
  readonly startedAt: string | null;
};

/** 连续工具调用的折叠组:组内任意 running→running,任意 failed→failed,否则 completed。 */
export type ToolCallGroup = {
  readonly key: string;
  readonly turnKey: string;
  readonly status: ToolCallStatus;
  readonly calls: readonly ToolCallEntry[];
  /** 组内已知时长之和;全部未知为 null。 */
  readonly totalDurationMs: number | null;
};

type MutableToolCall = {
  readonly key: string;
  readonly toolCallId: string | null;
  readonly name: string;
  readonly args: string;
  readonly summary: string;
  readonly startedAt: string | null;
  /** 折叠组号:同一轮内 text/thinking/未配对 error 之后的调用开新组。 */
  groupId: number;
  status: ToolCallStatus;
  result: string | null;
  endedAt: string | null;
};

/**
 * 把转录轮次里的连续工具调用折叠成组:tool_call 开条目、tool_result/error 按调用 id
 * (无 id 的协议按同名顺序)配对收口;text/thinking 打断连续性、后续调用开新组。跨轮次
 * 不合并。组在轮末才物化——打断之后才迟到的结果仍能收口进正确的条目。
 */
export function toolCallGroups(turns: readonly SessionTranscriptTurn[]): readonly ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  for (const turn of turns) {
    const open: MutableToolCall[] = [],
      ordered: MutableToolCall[] = [];
    let groupId = 0;
    for (const item of turn.items) {
      if (item.type === "tool_call") {
        const entry: MutableToolCall = {
          key: item.key,
          toolCallId: item.toolCallId ?? null,
          name: item.label,
          args: item.detail,
          summary: item.summary,
          startedAt: item.occurredAt,
          groupId,
          status: "running",
          result: null,
          endedAt: null,
        };
        open.push(entry);
        ordered.push(entry);
        continue;
      }
      if (item.type === "tool_result" || item.type === "error") {
        const failed = item.type === "error",
          matched =
            (item.toolCallId !== undefined ? matchOpenCallById(open, item.toolCallId) : null) ??
            matchOpenCallByName(open, item.label);
        if (matched !== null) {
          matched.status = failed ? "failed" : "succeeded";
          matched.result = item.detail;
          matched.endedAt = item.occurredAt;
          open.splice(open.indexOf(matched), 1);
          continue;
        }
        if (!failed) continue; // 未配上的 tool_result(如 web search 汇总)不归任何调用,也不打断连续性
      }
      groupId += 1;
    }
    materializeToolCallGroups(groups, turn.key, ordered);
  }
  return groups;
}

function matchOpenCallById(open: readonly MutableToolCall[], toolCallId: string): MutableToolCall | null {
  return open.find((entry) => entry.toolCallId === toolCallId) ?? null;
}

function matchOpenCallByName(open: readonly MutableToolCall[], name: string): MutableToolCall | null {
  return open.find((entry) => entry.name === name) ?? null;
}

function materializeToolCallGroups(
  groups: ToolCallGroup[],
  turnKey: string,
  ordered: readonly MutableToolCall[],
): void {
  const buckets = new Map<number, MutableToolCall[]>();
  for (const entry of ordered) {
    const bucket = buckets.get(entry.groupId) ?? [];
    bucket.push(entry);
    buckets.set(entry.groupId, bucket);
  }
  for (const entries of buckets.values()) {
    const calls = entries.map((entry) => ({
      key: entry.key,
      name: entry.name,
      summary: entry.summary,
      status: entry.status,
      durationMs: elapsedMs(entry.startedAt, entry.endedAt),
      args: entry.args,
      result: entry.result,
      startedAt: entry.startedAt,
    }));
    const known = calls.map((call) => call.durationMs).filter((ms): ms is number => ms !== null);
    groups.push({
      key: `${turnKey}:tools:${groups.length}`,
      turnKey,
      status: calls.some((call) => call.status === "running")
        ? "running"
        : calls.some((call) => call.status === "failed")
          ? "failed"
          : "succeeded",
      calls,
      totalDurationMs: known.length === 0 ? null : known.reduce((sum, ms) => sum + ms, 0),
    });
  }
}

function elapsedMs(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const start = Date.parse(startedAt),
    end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
}

// ---- 计划步骤(Plan Steps) ----

export type PlanStepStatus = "pending" | "in_progress" | "completed";

/** 计划里的一步:来自转录流最新一次计划证据,视图原语 AgentPlan(W1-T2)的消费契约。 */
export type PlanStep = {
  readonly key: string;
  readonly content: string;
  readonly status: PlanStepStatus;
};

/**
 * 转录流里最新一次计划证据的步骤清单:Claude 的 TodoWrite tool_use(input.todos)与
 * codex 的 plan/todo/todo_list 项(与 daemon runtime-spawn-provider-frames 的解析同源)。
 * 计划是整体替换的,只保留最后一次观测;没有计划证据返回空数组,不虚构步骤。
 */
export function sessionPlanSteps(records: readonly Readonly<Record<string, unknown>>[]): readonly PlanStep[] {
  let steps: readonly PlanStep[] = [];
  for (const record of records) {
    if (record.kind !== "provider_event") continue;
    const event = recordOf(record.event);
    if (event === null) continue;
    const type = stringOf(event.type),
      next = type === "assistant" ? claudeTodoSteps(event) : codexPlanSteps(event, type ?? "");
    if (next !== null) steps = next;
  }
  return steps;
}

/** Claude:assistant 消息里的 TodoWrite tool_use,input.todos 是步骤数组;不是计划返回 null。 */
function claudeTodoSteps(event: Readonly<Record<string, unknown>>): readonly PlanStep[] | null {
  const message = recordOf(event.message),
    content = message !== null && Array.isArray(message.content) ? message.content : null;
  if (content === null) return null;
  const todoWrite = content
    .map(recordOf)
    .filter(isPresent)
    .find((part) => stringOf(part.type) === "tool_use" && stringOf(part.name) === "TodoWrite");
  if (todoWrite === undefined) return null;
  const input = recordOf(todoWrite.input),
    todos = input !== null && Array.isArray(input.todos) ? input.todos : null;
  return todos === null ? [] : todos.map(recordOf).filter(isPresent).map(planStepOf);
}

/** codex:plan/todo/todo_list 项,步骤数组在 plan/items/todos 任一字段(daemon 同源口径)。 */
function codexPlanSteps(event: Readonly<Record<string, unknown>>, type: string): readonly PlanStep[] | null {
  if (type !== "item.started" && type !== "item.completed" && type !== "item.updated") return null;
  const item = recordOf(event.item);
  if (item === null || !["plan", "todo", "todo_list"].includes(stringOf(item.type) ?? "")) return null;
  const entries = [item.plan, item.items, item.todos].find(Array.isArray) ?? null;
  return entries === null ? [] : entries.map(recordOf).filter(isPresent).map(planStepOf);
}

function planStepOf(entry: Readonly<Record<string, unknown>>): PlanStep {
  const content =
    stringOf(entry.content) ??
    stringOf(entry.text) ??
    stringOf(entry.step) ??
    stringOf(entry.title) ??
    contentOf(entry);
  return {
    key: `plan:${summaryOf(content)}`,
    content,
    status: planStepStatusOf(stringOf(entry.status) ?? stringOf(entry.state) ?? ""),
  };
}

function planStepStatusOf(word: string): PlanStepStatus {
  const normalized = word.toLowerCase();
  if (["completed", "done", "complete"].includes(normalized)) return "completed";
  if (["in_progress", "in-progress", "running", "active"].includes(normalized)) return "in_progress";
  return "pending";
}

// ---- Steering 待注入队列 ----

export type SteeringEntryStatus = "pending" | "injected" | "rejected";

/** 一条排队待注入的 Steering 指令:注入证据是转录流里 queuedAtMs 之后真实的用户消息。 */
export type SteeringQueueEntry = {
  readonly id: string;
  readonly prompt: string;
  readonly queuedAtMs: number;
  readonly status: SteeringEntryStatus;
  readonly settledAtMs: number | null;
  readonly reason: string | null;
};
export type SteeringQueue = readonly SteeringQueueEntry[];

export function enqueueSteering(queue: SteeringQueue, id: string, prompt: string, queuedAtMs: number): SteeringQueue {
  return [...queue, { id, prompt, queuedAtMs, status: "pending", settledAtMs: null, reason: null }];
}

export function rejectSteering(queue: SteeringQueue, id: string, reason: string, nowMs: number): SteeringQueue {
  return queue.map((entry) =>
    entry.id === id && entry.status === "pending"
      ? { ...entry, status: "rejected", settledAtMs: nowMs, reason }
      : entry,
  );
}

/**
 * 消费注入证据:第 i 个 pending(按队列序)由 queuedAtMs 之后第 i 条用户消息证明已注入,
 * 每条消息只消费一个条目;消息时间早于排队时刻的不能证明注入。注入与排队同序,不抢号。
 */
export function consumeSteering(queue: SteeringQueue, userMessageAt: readonly number[]): SteeringQueue {
  const evidence = [...userMessageAt].sort((left, right) => left - right);
  let cursor = 0;
  return queue.map((entry) => {
    if (entry.status !== "pending") return entry;
    for (let index = cursor; index < evidence.length; index += 1) {
      if (evidence[index] >= entry.queuedAtMs) {
        cursor = index + 1;
        return { ...entry, status: "injected", settledAtMs: evidence[index], reason: null };
      }
    }
    return entry;
  });
}

/**
 * 转录记录里真实用户消息的时间戳(升序):user 事件且 content 含 text 段。tool_result
 * 回传也是 user 事件,但那是工具结果不是人写的指令,不算注入证据。
 */
export function sessionUserMessageTimestamps(records: readonly Readonly<Record<string, unknown>>[]): readonly number[] {
  const stamps: number[] = [];
  for (const record of records) {
    if (record.kind !== "provider_event") continue;
    const event = recordOf(record.event);
    if (event === null || stringOf(event.type) !== "user") continue;
    const message = recordOf(event.message),
      content = message !== null && Array.isArray(message.content) ? message.content : null;
    if (content === null) continue;
    const hasUserText = content
      .map(recordOf)
      .filter(isPresent)
      .some((part) => stringOf(part.type) === "text");
    if (!hasUserText) continue;
    const at = Date.parse(stringOf(record.occurredAt) ?? stringOf(record.at) ?? "");
    if (Number.isFinite(at)) stamps.push(at);
  }
  return stamps;
}

function toolLabel(item: Readonly<Record<string, unknown>>): string {
  return stringOf(item.name) ?? stringOf(item.server) ?? (item.type === "command_execution" ? "command" : "tool");
}

function toolInput(item: Readonly<Record<string, unknown>>): string {
  return stringOf(item.command) ?? contentOf(item.arguments ?? item.query ?? item);
}

function toolOutput(item: Readonly<Record<string, unknown>>): string {
  const output = stringOf(item.aggregated_output) ?? stringOf(item.output);
  if (output) return output;
  const exitCode = numberOf(item.exit_code);
  return exitCode === null ? contentOf(item) : `exit code ${exitCode}`;
}

function contentOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) => {
        const record = recordOf(part);
        return record ? (stringOf(record.text) ?? contentOf(record)) : String(part);
      })
      .join("\n");
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summaryOf(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}…` : compact;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
