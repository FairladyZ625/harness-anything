// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonBuildStamp } from "../src/build-identity.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

// The handshake is the one place every client converges, so the daemon's build identity rides on
// protocol.hello: a client that can name its own commit can diagnose skew before it surfaces as
// schema rejections, without a second round trip or a new method.
test("protocol.hello answers with the daemon's build stamp", async () => {
  let shutdowns = 0;
  const server = createJsonRpcProtocolServer({ host: {} as never, authContext: { transportKind: "unix-socket" } as DaemonAuthenticationContext, emit: async () => undefined, requestShutdown: () => { shutdowns += 1; } });
  try {
    const hello = await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
    const result = (hello as { readonly result: { readonly build?: { readonly commit: string | null } } }).result;
    assert.equal(result.build?.commit, daemonBuildStamp().commit, "hello must report the same stamp the status surfaces report");
    const stop = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
    assert.equal((stop as { readonly result: { readonly ok: boolean } }).result.ok, true, JSON.stringify(stop));
    assert.equal(shutdowns, 1, "an accepted daemon.stop must reach the shutdown owner exactly once");
  } finally { server.close(); }
});
