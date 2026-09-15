import { writeProviderExecutable } from "./runtime-stub.ts";

// Fake ACP provider executable. `acp` runs a JSON-RPC server over stdio that
// answers the handshake, echoes a fixed session id, streams canonical update
// notifications, and records the authenticate key plus server-initiated
// request outcomes into `captureTarget` for assertions. `auth`/`models`
// subcommands exit 0 so subscription probes pass.
export function writeAcpProviderStub(target: string, captureTarget: string): string {
  return writeProviderExecutable(
    target,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth" || args[0] === "models") process.exit(0);
if (args[0] !== "acp") process.exit(9);
const capture = ${JSON.stringify(captureTarget)};
const record = (entry) => fs.appendFileSync(capture, JSON.stringify(entry) + "\\n");
const sessionId = "devin-acp-session";
const modes = { currentModeId: "accept-edits", availableModes: [{ id: "accept-edits", name: "Code" }, { id: "plan", name: "Plan" }, { id: "bypass", name: "Bypass" }] };
let buffer = "", authenticated = false, pendingPromptId = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const finishPrompt = (id) => {
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking hard" } });
  update({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Edit file", kind: "edit", status: "in_progress" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" });
  update({ sessionUpdate: "plan", entries: [{ content: "step", status: "completed" }] });
  update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "noise" }] });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "devin live " } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "content" } });
  update({ sessionUpdate: "usage_update", used: 1234, size: 200000 });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } } });
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "session/cancel") { record({ cancel: message.params?.sessionId ?? null }); continue; }
    if (message.id === "perm-1" && message.result) {
      record({ permission: message.result.outcome ?? null });
      const id = pendingPromptId; pendingPromptId = null; finishPrompt(id); continue;
    }
    if (message.id === undefined || typeof message.method !== "string") continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    const fail = (text) => send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
    if (message.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "devin-browser", name: "browser" }] });
    else if (message.method === "authenticate") {
      const key = message.params?._meta?.api_key;
      if (typeof key === "string" && key) { authenticated = true; record({ apiKey: key }); reply({}); }
      else fail("api key required");
    } else if (!authenticated) fail("unauthenticated");
    else if (message.method === "session/new") reply({ sessionId, modes });
    else if (message.method === "session/load") reply({ modes });
    else if (message.method === "session/set_mode") { record({ mode: message.params?.modeId ?? null }); reply({}); }
    else if (message.method === "session/prompt") {
      const text = message.params?.prompt?.[0]?.text ?? "";
      if (text === "permission-probe") {
        pendingPromptId = message.id;
        send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc-9", title: "Write file" }, options: [{ optionId: "deny", kind: "reject_once", name: "Deny" }, { optionId: "allow", kind: "allow_once", name: "Allow" }] } });
      } else if (text === "hang") {
        pendingPromptId = message.id;
      } else finishPrompt(message.id);
    } else fail("unsupported");
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
}
