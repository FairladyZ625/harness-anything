import { clip, recordOf, stringOf } from "./daemon-observe-model.ts";

export type SessionTranscriptItemType = "thinking" | "tool_call" | "tool_result" | "text" | "error";

export interface SessionTranscriptItem {
  readonly key: string;
  readonly type: SessionTranscriptItemType;
  readonly label: string;
  readonly summary: string;
  readonly detail: string;
  readonly occurredAt: string | null;
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
            add(target, "tool_result", label, contentOf(part.content ?? part), at);
            current = target;
            continue;
          }
          const target = current ?? turn(`message:${messageId ?? turns.length}`, at);
          if (partType === "thinking") add(target, "thinking", "thinking", stringOf(part.thinking) ?? "", at);
          else if (partType === "text") add(target, "text", "text", stringOf(part.text) ?? "", at);
          else if (partType === "tool_use" || partType === "server_tool_use") {
            const toolId = stringOf(part.id),
              label = stringOf(part.name) ?? "tool";
            add(target, "tool_call", label, contentOf(part.input ?? part), at);
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
            add(current, "tool_call", label, toolInput(item), at);
            if (itemId) codexTools.set(itemId, { turn: current, label });
          } else {
            const known = itemId ? codexTools.get(itemId) : null,
              target = known?.turn ?? current;
            if (!known) add(target, "tool_call", label, toolInput(item), at);
            add(target, "tool_result", known?.label ?? label, toolOutput(item), at);
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
          add(current, "tool_call", label, contentOf(payload.input ?? payload), at);
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
        if (kind === "result" && payload) add(target, "tool_result", label, contentOf(payload.result), at);
        else if (kind === "error" && payload) add(target, "error", label, contentOf(payload.error), at);
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
          add(current, "tool_call", label, contentOf(update.rawInput ?? update), at);
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
            if (status === "failed") add(target, "error", label, output || "tool call failed", at);
            else if (output) add(target, "tool_result", label, output, at);
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
