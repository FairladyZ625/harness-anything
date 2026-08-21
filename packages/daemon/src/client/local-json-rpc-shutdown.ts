import { consumeKnownError } from "../../../kernel/src/index.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "../protocol/json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "../protocol/version.ts";
import { connectSocket, jsonRpcRecord } from "./local-json-rpc-client.ts";

export interface DaemonStopReply { readonly ok: boolean; readonly code: string | null; readonly message: string | null }
export interface DaemonShutdownExchange { readonly daemonCommit: string | null; readonly helloAnswered: boolean; readonly stopReply: DaemonStopReply | null }

// Stop used to be a blind write: the daemon's answer — including "Method not found" from a daemon
// predating daemon.stop — went unread, no fallback fired, and the caller timed out on a daemon that
// had told it no. The exchange reads the answers so the stop ladder and its diagnostics can act on
// what the daemon actually said. A daemon that accepts connection but never answers within the
// window is reported as stopReply null, which callers treat as a queued shutdown, not a rejection.
export async function requestDaemonShutdownAt(socketPath: string, timeoutMs = 75, responseTimeoutMs = 2_000): Promise<DaemonShutdownExchange> {
  const socket = await connectSocket(socketPath, timeoutMs);
  const payload = [
    { jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } } satisfies JsonRpcRequest,
    { jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} } satisfies JsonRpcRequest
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
  return new Promise<DaemonShutdownExchange>((resolve) => {
    const finish = (exchange: DaemonShutdownExchange) => { clearTimeout(timer); socket.destroy(); resolve(exchange); };
    const timer = setTimeout(() => finish({ daemonCommit: hello?.commit ?? null, helloAnswered: hello !== undefined, stopReply: stop ?? null }), responseTimeoutMs);
    let hello: { readonly commit: string | null } | undefined, stop: DaemonStopReply | null | undefined;
    socket.once("error", () => finish({ daemonCommit: hello?.commit ?? null, helloAnswered: hello !== undefined, stopReply: stop ?? null }));
    socket.on("close", () => finish({ daemonCommit: hello?.commit ?? null, helloAnswered: hello !== undefined, stopReply: stop ?? null }));
    socket.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        let response: JsonRpcResponse; try { response = JSON.parse(line) as JsonRpcResponse; } catch (error) { consumeKnownError(error); continue; }
        if (response.id === 1) hello = helloCommit(response);
        else if (response.id === 2) { stop = classifyStopReply(response); finish({ daemonCommit: hello?.commit ?? null, helloAnswered: hello !== undefined, stopReply: stop }); }
      }
    });
    socket.end(payload);
  });
}

function helloCommit(response: JsonRpcResponse): { readonly commit: string | null } | undefined {
  if (!("result" in response) || !jsonRpcRecord(response.result)) return undefined;
  const build = response.result.build;
  return { commit: jsonRpcRecord(build) && typeof build.commit === "string" ? build.commit : null };
}
function classifyStopReply(response: JsonRpcResponse): DaemonStopReply {
  if ("error" in response) return { ok: false, code: String(response.error.code), message: response.error.message };
  const result = "result" in response && jsonRpcRecord(response.result) ? response.result : {};
  const error = jsonRpcRecord(result.error) ? result.error : null;
  return { ok: result.ok === true, code: typeof result.code === "string" ? result.code : null, message: error !== null && typeof error.hint === "string" ? error.hint : null };
}
