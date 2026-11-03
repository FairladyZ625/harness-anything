import { connectSocket, jsonRpcRecord, executionCredentialParams, JsonRpcLineClient } from "./local-json-rpc-client.ts";

export interface DaemonStopReply {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string | null;
}
export interface DaemonShutdownExchange {
  readonly daemonCommit: string | null;
  readonly helloAnswered: boolean;
  readonly stopReply: DaemonStopReply | null;
}

// Stop is a business request: it must follow a successful identity handshake. The line client
// owns framing and version refusal, just as it does for ordinary requests and persistent readers.
export async function requestDaemonShutdownAt(
  socketPath: string,
  timeoutMs = 75,
  responseTimeoutMs = 2_000,
): Promise<DaemonShutdownExchange> {
  const socket = await connectSocket(socketPath, timeoutMs),
    client = new JsonRpcLineClient(socket, socket);
  let daemonCommit: string | null = null,
    helloAnswered = false;
  try {
    const hello = await client.request("protocol.hello", executionCredentialParams(), responseTimeoutMs);
    daemonCommit = jsonRpcRecord(hello.build) && typeof hello.build.commit === "string" ? hello.build.commit : null;
    helloAnswered = true;
    const result = await client.request("daemon.stop", {}, responseTimeoutMs),
      error = jsonRpcRecord(result.error) ? result.error : null;
    return {
      daemonCommit,
      helloAnswered,
      stopReply: {
        ok: result.ok === true,
        code: typeof result.code === "string" ? result.code : null,
        message: typeof error?.hint === "string" ? error.hint : null,
      },
    };
  } catch (error) {
    const code = (error as { readonly code?: unknown })?.code;
    if (code === "daemon_response_timeout" || code === "daemon_closed")
      return { daemonCommit, helloAnswered, stopReply: null };
    throw error;
  } finally {
    socket.destroy();
    client.close();
  }
}
