import net from "node:net";
import { createInterface } from "node:readline";
import { currentDaemonProtocolVersion } from "../../../daemon/src/protocol/version.ts";
import { daemonGuiStreamFacets, parseDaemonGuiStreamEvent, parseDaemonGuiStreamResult } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { AgentRuntimeAttachEvent, AgentRuntimeAttachResult } from "../../../daemon/src/agent-runtime-stream.ts";

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[]; type JsonObject = { readonly [key: string]: JsonValue };
export type AgentRuntimeStreamValue = AgentRuntimeAttachResult | AgentRuntimeAttachEvent;

export async function streamAgentRuntimeAt(input: { readonly socketPath: string; readonly repoId: string; readonly payload: { readonly runtimeSessionId: string; readonly afterCursor: string }; readonly onValue: (value: AgentRuntimeStreamValue) => void; readonly timeoutMs?: number }): Promise<() => void> {
  const socket = net.createConnection(input.socketPath), lines = createInterface({ input: socket }), timeoutMs = input.timeoutMs ?? 200;
  let settled = false, detached = false, resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { if (!settled) { settled = true; socket.destroy(); rejectReady(new Error("daemon_stream_unavailable")); } }, timeoutMs);
  socket.once("connect", () => { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: daemonGuiStreamFacets[0].method, params: { repo: { repoId: input.repoId }, payload: input.payload } })}\n`); });
  lines.on("line", (line) => { try { const value = JSON.parse(line) as { readonly id?: number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: { readonly message?: string } };
    if (value.id === 2) { if (value.error) throw new Error(value.error.message ?? "daemon stream failed"); const initial = parseDaemonGuiStreamResult("repo.agentRuntime.attach", value.result); input.onValue(initial); settled = true; clearTimeout(timer); resolveReady(); if (!initial.ok) socket.end(); }
    else if (value.method === daemonGuiStreamFacets[0].eventMethod) input.onValue(parseDaemonGuiStreamEvent(value.params));
  } catch (error) { consumeKnownError(error); if (!settled) { settled = true; clearTimeout(timer); rejectReady(error instanceof Error ? error : new Error(String(error))); } socket.destroy(); } });
  socket.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(error); } }); socket.once("close", () => { lines.close(); if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error("daemon stream closed before attach")); } });
  await ready; return () => { if (detached) return; detached = true; lines.close(); socket.end(); };
}
function consumeKnownError(error: unknown): void { void error; }
