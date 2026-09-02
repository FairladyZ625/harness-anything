// The thin entry reaches the daemon transport by dynamic import so the dist static graph stays
// entry/parser/transport-only, and every daemon branch of runCommandThroughDaemon issues its
// request through the single reference this returns. One wrapper here therefore covers every round
// trip a command actually makes -- three for a fleet-routed write, one per status poll for a preset
// run -- with no instrumentation at any call site. With timing off, timedDaemonRequest hands back
// the transport function itself, so a disabled invocation carries no wrapper at all.
import { timedDaemonRequest } from "../cli/timing.ts";

type DaemonRpcRequest =
  (typeof import("../../../daemon/src/client/local-json-rpc-client.ts"))["requestLocalDaemonJsonRpcForTarget"];

export async function timedDaemonTransport(): Promise<DaemonRpcRequest> {
  const transport = await import("../../../daemon/src/client/local-json-rpc-client.ts");
  return timedDaemonRequest(transport.requestLocalDaemonJsonRpcForTarget, (args) => args[1]);
}
