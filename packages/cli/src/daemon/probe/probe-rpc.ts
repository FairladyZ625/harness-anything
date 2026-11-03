import { connectSocket, JsonRpcLineClient } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { currentDaemonProtocolVersion } from "@harness-anything/daemon/internal/protocol/version";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

// The probe is a local observer, so it speaks over the same user-owned socket a human `ha daemon
// status` uses and does not attach an execution credential. Sending one would make the daemon
// reject `daemon.status` by policy (execution credentials may not perform daemon controls), which
// would report a healthy daemon as down. Socket ownership is the local trust boundary here.
export interface ProbeRpc {
  readonly client: JsonRpcLineClient;
  readonly hello: JsonObject;
}

export async function openProbeRpc(socketPath: string, timeoutMs: number): Promise<ProbeRpc> {
  const socket = await connectSocket(socketPath, timeoutMs),
    client = new JsonRpcLineClient(socket, socket);
  try {
    const hello = await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, timeoutMs);
    return { client, hello };
  } catch (error) {
    client.close();
    throw error;
  }
}
