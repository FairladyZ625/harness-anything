import { writeProviderExecutable } from "./runtime-stub.ts";

// Fake ACP provider executable. `acp` runs a JSON-RPC server over stdio that
// answers the handshake, echoes a fixed session id, streams canonical update
// notifications, and records the authenticate key plus server-initiated
// request outcomes into `captureTarget` for assertions. `auth`/`models`
// subcommands exit 0 so subscription probes pass. Like devin 3000.10.x, the
// server exits 0 without answering once the pid in WINDSURF_EXT_HOST_PID is
// gone; `--model exit-before-session` and the `exit-mid-prompt` prompt exit 0
// with the turn unanswered as well.
export function writeAcpProviderStub(
  target: string,
  captureTarget: string,
  options: {
    readonly authMethods?: readonly Record<string, unknown>[];
    readonly modes?: Record<string, unknown>;
    /** The initialize response's agentCapabilities; defaults to a loadSession-only agent.
     * session/resume is answered only when sessionCapabilities.resume is advertised. */
    readonly agentCapabilities?: Record<string, unknown>;
    /** Extra fields merged into the session/new and session/load results —
     * e.g. a spec `models` block or `configOptions` model selector. */
    readonly session?: Record<string, unknown>;
    /** Real-agent steer semantics: session/cancel answers the pending prompt with
     * stopReason "cancelled" and every answered prompt text is recorded to the
     * capture file, so steering round trips are assertable. */
    readonly steerSemantics?: boolean;
    /** First prompt performs command work and ends without settlement; later prompts complete normally. */
    readonly unsettledTurn?: boolean;
    readonly unsettledCommandStatus?: "pending" | "in_progress" | "completed" | "failed";
    /** Every prompt performs command work and ends without settlement. */
    readonly unsettledTurnAlways?: boolean;
    /** First prompt performs a command that includes a task settlement action. */
    readonly settledCommand?: boolean;
    /** Emit an explicit ACP protocol error update before the final result. */
    readonly protocolError?: Record<string, unknown>;
    /** Replace the normal final text with an upstream error payload and emit no tools. */
    readonly upstreamError?: string;
    /** Emit a non-command tool call before the upstream error payload. */
    readonly upstreamErrorAfterToolCall?: boolean;
    readonly usage?: Record<string, unknown>;
  } = {},
): string {
  return writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth" || args[0] === "models" || args[0] === "--version") process.exit(0);
if (args[0] !== "acp") process.exit(9);
const capture = ${JSON.stringify(captureTarget)};
const record = (entry) => fs.appendFileSync(capture, JSON.stringify(entry) + "\\n");
const sessionId = "devin-acp-session";
const modes = ${JSON.stringify(
      options.modes ?? {
        currentModeId: "accept-edits",
        availableModes: [
          { id: "accept-edits", name: "Code" },
          { id: "plan", name: "Plan" },
          { id: "bypass", name: "Bypass" },
        ],
      },
    )};
const sessionExtras = ${JSON.stringify(
      options.session ?? {
        models: {
          currentModelId: "swe-2-medium",
          availableModels: [
            { modelId: "swe-2-medium", name: "SWE-2 Medium" },
            { modelId: "swe-2-high", name: "SWE-2 High" },
          ],
        },
      },
    )};
const editorHostPid = Number(process.env.WINDSURF_EXT_HOST_PID ?? 0);
const steerSemantics = ${JSON.stringify(options.steerSemantics === true)};
const unsettledTurn = ${JSON.stringify(options.unsettledTurn === true)};
const unsettledCommandStatus = ${JSON.stringify(options.unsettledCommandStatus ?? "completed")};
const unsettledTurnAlways = ${JSON.stringify(options.unsettledTurnAlways === true)};
const settledCommand = ${JSON.stringify(options.settledCommand === true)};
const protocolError = ${JSON.stringify(options.protocolError ?? null)};
const upstreamError = ${JSON.stringify(options.upstreamError ?? null)};
const upstreamErrorAfterToolCall = ${JSON.stringify(options.upstreamErrorAfterToolCall === true)};
const usageExtra = ${JSON.stringify(options.usage ?? {})};
const editorHostGone = () => {
  if (!editorHostPid) return false;
  try { process.kill(editorHostPid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
};
let buffer = "", authenticated = false, pendingPromptId = null, pendingPromptText = "", promptCount = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const finishPrompt = (id, text) => {
  promptCount += 1;
  if (steerSemantics || unsettledTurnAlways) record({ prompt: text });
  if (upstreamError !== null) {
    if (upstreamErrorAfterToolCall)
      update({ sessionUpdate: "tool_call", toolCallId: "tc-read", title: "Read file", kind: "read", status: "completed" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: upstreamError } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
    return;
  }
  if (unsettledTurn && promptCount === 1) {
    update({ sessionUpdate: "tool_call", toolCallId: "tc-command", title: "shell", kind: "command", status: unsettledCommandStatus });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progress" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
    return;
  }
  if (unsettledTurnAlways || (settledCommand && promptCount === 1)) {
    update({ sessionUpdate: "tool_call", toolCallId: "tc-command", title: "shell", kind: "command", input: { command: settledCommand ? "ha task submit task_1234567890" : "echo progress" }, status: "completed" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: settledCommand ? "settled" : "progress" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
    return;
  }
  if (protocolError !== null) update({ sessionUpdate: "error", error: protocolError });
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking hard" } });
  update({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Edit file", kind: "edit", status: "in_progress" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" });
  update({ sessionUpdate: "plan", entries: [{ content: "step", status: "completed" }] });
  update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "noise" }] });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "devin live " } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "content" } });
  update({ sessionUpdate: "usage_update", used: 1234, size: 200000 });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20, ...usageExtra } } });
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "session/cancel") {
      record({ cancel: message.params?.sessionId ?? null });
      if (steerSemantics && pendingPromptId !== null) {
        const id = pendingPromptId;
        pendingPromptId = null;
        send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      }
      continue;
    }
    if (message.id === "perm-1" && message.result) {
      record({ permission: message.result.outcome ?? null });
      const id = pendingPromptId, text = pendingPromptText;
      pendingPromptId = null; pendingPromptText = "";
      finishPrompt(id, text);
      continue;
    }
    if (message.id === undefined || typeof message.method !== "string") continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    const fail = (text) => send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
    if (message.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: ${JSON.stringify(
      options.agentCapabilities ?? { loadSession: true },
    )}, authMethods: ${JSON.stringify(options.authMethods ?? [{ id: "devin-browser", name: "browser" }])} });
    else if (message.method === "authenticate") {
      const key = message.params?._meta?.api_key, methodId = message.params?.methodId;
      if (typeof key === "string" && (key || methodId === "cursor_login" || methodId === "chat-gpt")) {
        authenticated = true; record({ apiKey: key, methodId }); reply({});
      } else fail("api key required");
    } else if (!authenticated) fail("unauthenticated");
    else if (message.method === "session/new") {
      if (editorHostGone() || args.includes("exit-before-session")) process.exit(0);
      reply({ sessionId, modes, ...sessionExtras });
    }
    else if (message.method === "session/load") {
      // Real agents replay session history before answering session/load.
      record({ load: message.params?.sessionId ?? null });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "devin history " } });
      reply({ modes, ...sessionExtras });
    }
    else if (message.method === "session/resume") {
      // Spec: session/resume restores the context without replaying history; only an
      // agent advertising sessionCapabilities.resume ever sees this request.
      record({ resume: message.params?.sessionId ?? null });
      reply({ modes, ...sessionExtras });
    }
    else if (message.method === "session/set_mode") { record({ mode: message.params?.modeId ?? null }); reply({}); }
    else if (message.method === "session/set_config_option") {
      // Like the spec: answer with the full selector set, the chosen option now current.
      const { configId, value } = message.params ?? {};
      record({ configOption: { configId: configId ?? null, value: value ?? null } });
      reply({ configOptions: (sessionExtras.configOptions ?? []).map((option) => option.id === configId ? { ...option, currentValue: value } : option) });
    }
    else if (message.method === "session/prompt") {
      const text = message.params?.prompt?.[0]?.text ?? "";
      if (text === "permission-probe") {
        pendingPromptId = message.id;
        pendingPromptText = text;
        send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc-9", title: "Write file" }, options: [{ optionId: "deny", kind: "reject_once", name: "Deny" }, { optionId: "allow", kind: "allow_once", name: "Allow" }] } });
      } else if (text === "hang") {
        pendingPromptId = message.id;
        pendingPromptText = text;
      } else if (text === "exit-mid-prompt") {
        update({ sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Read file", kind: "read", status: "in_progress" });
        process.stdout.write("", () => process.exit(0));
      } else finishPrompt(message.id, text);
    } else fail("unsupported");
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
}
