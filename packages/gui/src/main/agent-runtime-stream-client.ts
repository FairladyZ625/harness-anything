import net from "node:net";
import { createInterface } from "node:readline";
import { currentDaemonProtocolVersion } from "../../../daemon/src/protocol/version.ts";
import { daemonGuiStreamFacets, type DaemonGuiStreamPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts"; import { parseDaemonGuiStreamEvent, parseDaemonGuiStreamResult } from "../../../daemon/src/protocol/gui-result-validation.ts";
import type { AgentRuntimeAttachEvent, AgentRuntimeAttachResult } from "../../../daemon/src/agent-runtime-stream.ts";

export type AgentRuntimeStreamValue = AgentRuntimeAttachResult | AgentRuntimeAttachEvent;
export async function streamAgentRuntimeAt(input: { readonly socketPath: string; readonly repoId: string; readonly payload: DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"]; readonly onValue: (value: AgentRuntimeStreamValue) => void; readonly timeoutMs?: number }): Promise<() => void> {
  let detached = false, everAttached = false, socket: net.Socket | undefined, retry: ReturnType<typeof setTimeout> | undefined, cursor = input.payload.afterCursor;
  const connect = () => new Promise<void>((resolve, reject) => { const next = net.createConnection(input.socketPath), lines = createInterface({ input: next }), timeout = setTimeout(() => fail(new Error("daemon_stream_unavailable")), input.timeoutMs ?? 200); socket = next; let settled = false, supported = true;
    next.once("connect", () => { next.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: daemonGuiStreamFacets[0].method, params: { repo: { repoId: input.repoId }, payload: { runtimeSessionId: input.payload.runtimeSessionId, afterCursor: cursor } } })}\n`); });
    lines.on("line", (line) => { try { const value = JSON.parse(line) as { readonly id?: number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: { readonly message?: string } }; if (value.id === 2) { if (value.error) throw new Error(value.error.message ?? "daemon stream failed"); const initial = parseDaemonGuiStreamResult("repo.agentRuntime.attach", value.result); input.onValue(initial); supported = initial.ok; if (initial.ok) { cursor = initial.cursor; everAttached = true; } settled = true; clearTimeout(timeout); resolve(); if (!supported) next.end(); } else if (value.method === daemonGuiStreamFacets[0].eventMethod) { const event = parseDaemonGuiStreamEvent(value.params); cursor = event.cursor; input.onValue(event); } } catch (error) { consumeKnownError(error); fail(error instanceof Error ? error : new Error(String(error))); } });
    lines.on("error", consumeKnownError); next.once("error", fail); next.once("close", () => { lines.close(); clearTimeout(timeout); if (!settled && !everAttached) { reject(new Error("daemon stream closed before attach")); return; } if (!detached && supported && everAttached) retry = setTimeout(() => { void connect().catch(consumeKnownError); }, 40); });
    function fail(error: Error): void { clearTimeout(timeout); if (!settled) reject(error); next.destroy(); }
  });
  await connect(); return () => { if (detached) return; detached = true; if (retry) clearTimeout(retry); socket?.end(); };
}
function consumeKnownError(error: unknown): void { void error; }
