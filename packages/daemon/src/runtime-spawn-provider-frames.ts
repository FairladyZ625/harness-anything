import { consumeKnownError } from "../../kernel/src/index.ts";
import { validateAgentDeclarationV1 } from "../../kernel/src/index.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instances.ts";
import type { AgentRuntimeNativeSignal } from "./agent-runtime-stream.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import type { ProviderFrame } from "./runtime-spawn-types.ts";
import { providerFaultFromFrame } from "./runtime-provider-fault.ts";

export function parseProviderFrame(kindId: RuntimeInstanceKind, value: unknown): ProviderFrame {
  if (!isPlainRecord(value) || (typeof value.event !== "string" && typeof value.type !== "string"))
    throw new Error("provider frame is not a structured event");
  const identity = runtimeKindForId(kindId).sessionIdentityResolver.resolve({
      runtime: kindId,
      dispatchEvents: [value],
    }),
    semantic =
      kindId === "claude"
        ? parseClaudeFrame(value, identity.sessionId)
        : kindId === "codex"
          ? parseCodexFrame(value, identity.sessionId)
          : parseAgyFrame(value, identity.sessionId);
  const providerFault = providerFaultFromFrame(kindId, value),
    observed = providerFault ? { ...semantic, providerFault } : semantic;
  return identity.sessionId === null ? observed : { ...observed, sessionIdentity: identity };
}

export function isStructuredSuccessResult(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      (parsed.schema === "runtime-batch/v1" && Array.isArray(parsed.dispatches) && parsed.dispatches.length > 0) ||
      validateAgentDeclarationV1(parsed).length === 0
    );
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
}

export function parseClaudeFrame(value: Record<string, unknown>, providerSessionId: string | null): ProviderFrame {
  if (
    (value.type === "system" && value.subtype === "init" && !providerSessionId) ||
    (value.type === "result" && (typeof value.result !== "string" || !providerSessionId))
  )
    throw new Error("Claude frame is incomplete");
  if (value.type === "assistant") {
    const message = isPlainRecord(value.message) ? value.message : null,
      content = message && Array.isArray(message.content) ? message.content : null;
    if (!content) throw new Error("Claude assistant frame is incomplete");
    const plan = content.filter(isPlainRecord).find((item) => item.type === "tool_use" && item.name === "TodoWrite");
    return {
      signals: content.flatMap(claudeContent),
      toolCallObserved: content.some(
        (item) => isPlainRecord(item) && ["tool_use", "server_tool_use"].includes(String(item.type)),
      ),
      planObserved: plan !== undefined,
      ...(plan ? { planIncomplete: planHasIncompleteItems(plan) } : {}),
    };
  }
  if (value.type === "user")
    return {
      writeItemObserved:
        isPlainRecord(value.tool_use_result) && ["create", "update"].includes(String(value.tool_use_result.type)),
    };
  if (value.type === "result")
    return {
      finalText: value.result as string,
      outcome:
        value.is_error === false && value.subtype === "success"
          ? Array.isArray(value.permission_denials) && value.permission_denials.length
            ? "unknown"
            : "succeeded"
          : "failed",
    };
  return {};
}

export function claudeContent(value: unknown): readonly AgentRuntimeNativeSignal[] {
  if (!isPlainRecord(value) || typeof value.type !== "string") return [];
  if (value.type === "text" && typeof value.text === "string")
    return [{ type: "activity", activity: "message", content: value.text }];
  if (value.type === "thinking" && typeof value.thinking === "string")
    return [{ type: "activity", activity: "thinking", content: value.thinking }];
  if (["tool_use", "tool_result", "server_tool_use", "web_search_tool_result"].includes(value.type))
    return [{ type: "activity", activity: "tool", content: JSON.stringify(value) }];
  return [];
}

export function parseCodexFrame(value: Record<string, unknown>, providerSessionId: string | null): ProviderFrame {
  if (value.type === "thread.started") {
    if (!providerSessionId) throw new Error("Codex thread frame is incomplete");
    return {};
  }
  if (value.type === "item.completed" || value.type === "item.updated") {
    const item = value.item;
    if (!isPlainRecord(item) || typeof item.type !== "string") throw new Error("Codex item frame is incomplete");
    const itemType = item.type;
    if (itemType === "agent_message") {
      const text = item.text;
      if (typeof text !== "string") throw new Error("Codex message frame is incomplete");
      return {
        signals: [{ type: "activity", activity: "message", content: text }],
        finalText: text,
      };
    }
    if (itemType === "reasoning") {
      const text = item.text;
      if (typeof text === "string")
        return {
          signals: [{ type: "activity", activity: "thinking", content: text }],
        };
    }
    if (itemType === "error") {
      const message = item.message;
      if (typeof message === "string")
        return {
          signals: [{ type: "activity", activity: "message", content: message }],
          failureText: message,
        };
    }
    if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(itemType))
      return {
        signals: [{ type: "activity", activity: "tool", content: JSON.stringify(item) }],
        toolCallObserved: true,
        writeItemObserved: itemType === "file_change" && item.status === "completed",
      };
    if (["plan", "todo", "todo_list"].includes(itemType))
      return {
        planObserved: true,
        planIncomplete: planHasIncompleteItems(item),
      };
    return {};
  }
  if (value.type === "turn.completed") return { outcome: "succeeded" };
  if (value.type === "turn.failed") {
    const failureText = isPlainRecord(value.error) ? JSON.stringify(value.error) : undefined;
    return {
      outcome: "failed",
      ...(failureText
        ? {
            failureText,
            signals: [
              {
                type: "activity" as const,
                activity: "message" as const,
                content: failureText,
              },
            ],
          }
        : {}),
    };
  }
  return {};
}

export function parseAgyFrame(value: Record<string, unknown>, providerSessionId: string | null): ProviderFrame {
  if (value.event === "init") {
    if (!providerSessionId) throw new Error("agy init frame is incomplete");
    return {};
  }
  if (value.event === "step_update") {
    const update = value.step_update;
    if (!isPlainRecord(update)) throw new Error("agy step_update frame is incomplete");
    const text = update.text_delta;
    if (typeof text === "string") return { signals: [{ type: "activity", activity: "message", content: text }] };
    // Tool steps carry no text; without them a read-only recon run looks idle until its final answer.
    if (update.step_type === "tool") {
      const { conversation_id: _conversation, step_index: _index, ...tool } = update;
      return { signals: [{ type: "activity", activity: "tool", content: JSON.stringify(tool) }] };
    }
    return {};
  }
  if (value.event === "result") {
    const result = value.result;
    if (!isPlainRecord(result) || typeof result.status !== "string" || typeof result.response !== "string")
      throw new Error("agy result frame is incomplete");
    return {
      finalText: result.response,
      outcome: result.status === "SUCCESS" ? "succeeded" : "failed",
      ...(result.status === "SUCCESS"
        ? {}
        : {
            failureText: typeof result.error === "string" ? result.error : `agy reported ${result.status}`,
          }),
    };
  }
  throw new Error(`agy event ${String(value.event)} is unsupported`);
}

export function planHasIncompleteItems(item: Record<string, unknown>): boolean {
  const value = isPlainRecord(item.input) ? item.input : item,
    entries = [value.plan, value.items, value.todos].find(Array.isArray);
  return (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        isPlainRecord(entry) && !["completed", "done", "complete"].includes(String(entry.status).toLowerCase()),
    )
  );
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
