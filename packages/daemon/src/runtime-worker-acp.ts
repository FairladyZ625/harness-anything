// ACP (Agent Client Protocol) client loop for acp-family runtime kinds. The
// worker host spawns the provider executable (`devin acp`, …) and this module
// drives the JSON-RPC 2.0 handshake over the child's stdio, translating ACP
// session traffic into the canonical dispatch-stream frame vocabulary:
//
//   {type:"acp.session", sessionId, modes, currentMode, models?, currentModelId?}
//                                                       emitted once after session/new|load
//   {type:"acp.mode",    sessionId, requested, applied}   permission-mode mapping result
//   {type:"acp.update",  sessionId, update, usage?}       whitelisted session/update kinds
//   {type:"acp.result",  sessionId, stopReason, finalText, usage?}
//   {type:"acp.error",   sessionId?, message}
//
// Every canonical frame carries `sessionId` once the session exists, which the
// acp sessionIdentity declaration (eventIdField "sessionId", no discriminator)
// resolves — including during resume admission, where session/load returning the
// recorded id is the whole proof.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { providerConfigDirectory } from "./agent-runtime-instance-storage.ts";

export interface AcpWorkerManifest {
  readonly kindId: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly permissionMode?: string;
  readonly providerSessionId?: string;
  readonly acpApiKey?: string;
}

type JsonRpcId = number;
type Append = (value: Readonly<Record<string, unknown>>) => void;

const handshakeTimeoutMs = 30_000;
const cancelGraceMs = 2_000;

// Updates worth persisting. Agents emit plenty of configuration chatter
// (available_commands_update, session_info_update, …) that carries no runtime
// signal, so the whitelist keeps the dispatch stream lean.
const observedUpdates = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "usage_update",
  "current_mode_update",
]);

const modePreference: Readonly<Record<string, readonly string[]>> = {
  bypass: ["bypass", "yolo", "full-access", "agent-full-access", "bypassPermissions", "agent"],
  "workspace-write": ["accept-edits", "workspace-write", "acceptEdits", "autoEdit", "auto-edit", "smart", "agent"],
  "read-only": ["plan", "read-only", "readonly", "ask"],
};

export function runAcpProviderSession(
  child: ChildProcess,
  manifest: AcpWorkerManifest,
  append: Append,
): { readonly done: Promise<void>; readonly cancel: () => void } {
  let nextId: JsonRpcId = 1,
    buffer = "",
    sessionId: string | null = null,
    finalText = "";
  const pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const send = (message: Record<string, unknown>): void => {
    try {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      consumeKnownError(error);
    }
  };
  // Handshake calls get a bounded wait; session/prompt has none — a turn runs as
  // long as the provider runs, same as the other runtime kinds.
  const request = (method: string, params: Record<string, unknown>, timeoutMs = handshakeTimeoutMs): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`ACP ${method} timed out`));
            }, timeoutMs)
          : null;
      timeout?.unref();
      pending.set(id, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const event = (frame: Record<string, unknown>): void =>
    append({ kind: "provider_event", event: scrubProviderValue(sessionId ? { sessionId, ...frame } : frame) });
  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    event({ type: "acp.error", message });
    try {
      child.kill("SIGTERM");
    } catch (killError) {
      consumeKnownError(killError);
    }
  };
  const permissionOutcome = (params: Record<string, unknown>): Record<string, unknown> => {
    const options = Array.isArray(params.options) ? (params.options as Record<string, unknown>[]) : [],
      allow = options.find((option) => String(option.kind ?? "").startsWith("allow")),
      reject = options.find((option) => String(option.kind ?? "").startsWith("reject")),
      chosen = manifest.permissionMode === "read-only" ? (reject ?? allow) : (allow ?? reject);
    return chosen && typeof chosen.optionId === "string"
      ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };
  const handleMessage = (message: Record<string, unknown>): void => {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id as JsonRpcId);
      pending.delete(message.id as JsonRpcId);
      if (!entry) return;
      if (message.error !== undefined) {
        const rpcError = message.error as Record<string, unknown>;
        entry.reject(new Error(String(rpcError.message ?? "ACP request failed")));
      } else entry.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      // Server-initiated request: permission prompts are answered from the
      // instance's permission mode; everything else (fs/*, terminal/*) was never
      // advertised, so it is refused as unsupported.
      send(
        message.method === "session/request_permission"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: permissionOutcome((message.params ?? {}) as Record<string, unknown>),
            }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } },
      );
      return;
    }
    if (message.method !== "session/update") return;
    const params = (message.params ?? {}) as Record<string, unknown>,
      update = (params.update ?? {}) as Record<string, unknown>,
      updateKind = String(update.sessionUpdate ?? "");
    if (updateKind === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      if (typeof content?.text === "string") finalText += content.text;
    }
    if (!observedUpdates.has(updateKind)) return;
    event(
      updateKind === "usage_update"
        ? { type: "acp.update", update, usage: acpUsage(update) }
        : { type: "acp.update", update },
    );
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        consumeKnownError(error);
        append({ kind: "provider_output_invalid", output: scrubProviderValue(line) });
      }
    }
  });
  const cancel = (): void => {
    if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        consumeKnownError(error);
      }
    }, cancelGraceMs).unref();
  };
  const done = (async () => {
    try {
      const initialize = (await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "harness-anything", title: "Harness Anything", version: "0.1.0" },
      })) as Record<string, unknown>;
      const authMethods = Array.isArray(initialize.authMethods)
        ? (initialize.authMethods as Record<string, unknown>[])
        : [];
      if (authMethods.length) {
        const declaration = runtimeKindForId(manifest.kindId),
          apiKey = manifest.acpApiKey ?? subscriptionApiKey(manifest),
          declaredMethod = "acpAuthMethod" in declaration.auth ? declaration.auth.acpAuthMethod : undefined,
          method = authMethods.find((entry) => entry.id === declaredMethod) ?? authMethods[0],
          methodId = typeof method?.id === "string" ? method.id : "default";
        // File-based login methods (cursor_login, chat-gpt) accept an empty
        // api_key and read the provider's own credential store; key-based
        // methods fail closed on the agent side when nothing resolves.
        await request("authenticate", { methodId, _meta: { api_key: apiKey ?? "" } });
      }
      const session = manifest.providerSessionId
        ? ((await request("session/load", {
            sessionId: manifest.providerSessionId,
            cwd: manifest.cwd,
            mcpServers: [],
          })) as Record<string, unknown>)
        : ((await request("session/new", {
            cwd: manifest.cwd,
            mcpServers: [],
          })) as Record<string, unknown>);
      sessionId = typeof session.sessionId === "string" ? session.sessionId : manifest.providerSessionId!;
      const modes = acpModes(session),
        models = acpModels(session);
      event({
        type: "acp.session",
        modes: modes.available,
        currentMode: modes.current,
        ...(models.available.length ? { models: models.available } : {}),
        ...(models.current ? { currentModelId: models.current } : {}),
      });
      const requested = manifest.permissionMode,
        applied = requested ? pickAcpMode(requested, modes.available) : null;
      if (applied && applied !== modes.current)
        try {
          await request("session/set_mode", { sessionId, modeId: applied });
        } catch (error) {
          consumeKnownError(error);
        }
      if (requested) event({ type: "acp.mode", requested, applied: applied ?? modes.current });
      const result = (await request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: manifest.prompt }],
        },
        0,
      )) as Record<string, unknown>;
      event({
        type: "acp.result",
        stopReason: result.stopReason ?? "end_turn",
        ...(finalText ? { finalText } : {}),
        ...(isRecord(result.usage) ? { usage: acpResultUsage(result.usage) } : {}),
      });
    } catch (error) {
      // The failure is reported through the acp.error frame and the child is
      // terminated — the canonical error channel, not a swallow.
      consumeKnownError(error);
      fail(error);
    } finally {
      try {
        child.stdin!.end();
      } catch (error) {
        consumeKnownError(error);
      }
    }
  })();
  return { done, cancel };
}

interface AcpModes {
  readonly available: readonly string[];
  readonly current: string | null;
}

function acpModes(session: Record<string, unknown>): AcpModes {
  const modes = isRecord(session.modes) ? session.modes : {},
    availableModes = Array.isArray(modes.availableModes) ? modes.availableModes : [],
    configOptions = Array.isArray(session.configOptions) ? session.configOptions : [],
    modeOption = configOptions.filter(isRecord).find((option) => option.category === "mode" || option.id === "mode"),
    optionValues =
      isRecord(modeOption) && Array.isArray(modeOption.options)
        ? modeOption.options.filter(isRecord).map((option) => option.value)
        : [];
  return {
    available: [
      ...new Set(
        [...availableModes.filter(isRecord).map((mode) => mode.id), ...optionValues].filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    ],
    current:
      typeof modes.currentModeId === "string"
        ? modes.currentModeId
        : isRecord(modeOption) && typeof modeOption.currentValue === "string"
          ? modeOption.currentValue
          : null,
  };
}

interface AcpModels {
  readonly available: readonly string[];
  readonly current: string | null;
}

// Agents advertise their model catalog two ways: the spec `models` block
// (codex-acp, cursor) and a select configOption with category "model"
// (devin, opencode — and cursor, which emits both). Both feed one list.
function acpModels(session: Record<string, unknown>): AcpModels {
  const models = isRecord(session.models) ? session.models : {},
    availableModels = Array.isArray(models.availableModels) ? models.availableModels : [],
    configOptions = Array.isArray(session.configOptions) ? session.configOptions : [],
    modelOption = configOptions.filter(isRecord).find((option) => option.category === "model" || option.id === "model"),
    optionValues =
      isRecord(modelOption) && Array.isArray(modelOption.options)
        ? modelOption.options.filter(isRecord).map((option) => option.value)
        : [];
  return {
    available: [
      ...new Set(
        [...availableModels.filter(isRecord).map((model) => model.modelId), ...optionValues].filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    ],
    current:
      typeof models.currentModelId === "string"
        ? models.currentModelId
        : isRecord(modelOption) && typeof modelOption.currentValue === "string"
          ? modelOption.currentValue
          : null,
  };
}

function pickAcpMode(requested: string, available: readonly string[]): string | null {
  for (const candidate of modePreference[requested] ?? []) if (available.includes(candidate)) return candidate;
  return null;
}

// Dispatch-stream scrubbing drops any key containing "token", so usage travels
// under neutral names; observeRuntimeMetrics maps them back onto the counters.
function acpUsage(update: Record<string, unknown>): Record<string, unknown> {
  const usage: Record<string, unknown> = {};
  if (typeof update.used === "number") usage.used = update.used;
  if (typeof update.size === "number") usage.context_size = update.size;
  return usage;
}

function acpResultUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof usage.inputTokens === "number") result.input = usage.inputTokens;
  if (typeof usage.outputTokens === "number") result.output = usage.outputTokens;
  if (typeof usage.totalTokens === "number") result.total = usage.totalTokens;
  return result;
}

// Subscription instances authenticate with the provider's own credential file:
// the CLI stores a TOML document under configDirectory/authFile and the ACP
// handshake forwards the declared key. Nothing is logged or persisted.
function subscriptionApiKey(manifest: AcpWorkerManifest): string | null {
  const declaration = runtimeKindForId(manifest.kindId),
    key = "acpCredentialKey" in declaration.auth ? declaration.auth.acpCredentialKey : undefined,
    authFile = declaration.executable.authFile,
    home = manifest.env.HOME ?? manifest.env.USERPROFILE;
  if (!key || !authFile || !home) return null;
  const file = path.join(providerConfigDirectory(home, manifest.kindId as RuntimeInstanceKind), authFile);
  if (!existsSync(file)) return null;
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "mu").exec(readFileSync(file, "utf8"));
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
