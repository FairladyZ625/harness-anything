import { connectSocket, JsonRpcLineClient } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

// The diagnostics socket is for local observers. Attaching a worker's execution credential would
// make the daemon reject even `daemon.status`, so this client sends the hello only; socket ownership
// is the local trust boundary. Same operation card as `ha daemon probe`.
export interface DiagnosticRpc {
  readonly client: JsonRpcLineClient;
  readonly hello: JsonObject;
}

export async function openDiagnosticRpc(socketPath: string, timeoutMs: number): Promise<DiagnosticRpc> {
  const socket = await connectSocket(socketPath, timeoutMs),
    client = new JsonRpcLineClient(socket, socket);
  try {
    const hello = await client.request("protocol.hello", {}, timeoutMs);
    return { client, hello };
  } catch (error) {
    client.close();
    throw error;
  }
}
