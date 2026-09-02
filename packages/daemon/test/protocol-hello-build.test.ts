// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

// The handshake is the one place every client converges, so the daemon's build identity rides on
// protocol.hello: a client that can name its own commit can diagnose skew before it surfaces as
// schema rejections, without a second round trip or a new method.
test("protocol.hello answers with the daemon's build stamp", async () => {
  let shutdowns = 0;
  const build = { commit: "0123456789abcdef0123456789abcdef01234567" };
  const server = createJsonRpcProtocolServer({
    host: {} as never,
    build,
    authContext: { transportKind: "unix-socket" } as DaemonAuthenticationContext,
    emit: async () => undefined,
    requestShutdown: () => {
      shutdowns += 1;
    },
  });
  try {
    const hello = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const result = (hello as { readonly result: { readonly build?: { readonly commit: string | null } } }).result;
    assert.equal(
      result.build?.commit,
      build.commit,
      "hello must report the stamp supplied by the daemon composition root",
    );
    const stop = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
    assert.equal((stop as { readonly result: { readonly ok: boolean } }).result.ok, true, JSON.stringify(stop));
    assert.equal(shutdowns, 1, "an accepted daemon.stop must reach the shutdown owner exactly once");
  } finally {
    server.close();
  }
});

test("protocol.hello reports a drifted build and keeps serving while work drains", async () => {
  let shutdowns = 0;
  const server = createJsonRpcProtocolServer({
    host: {} as never,
    build: { commit: "loaded" },
    buildObserver: {
      status: () => ({
        commit: "loaded",
        entry: "dist",
        loadedBuildId: "build-a",
        diskBuildId: "build-b",
        drifted: true,
      }),
    },
    authContext: { transportKind: "unix-socket" } as DaemonAuthenticationContext,
    emit: async () => undefined,
    requestShutdown: () => {
      shutdowns += 1;
    },
    buildDrainStatus: () => ({ liveRuntimeSessions: 2, pendingWrites: 1, attachingRepositories: 1 }),
  });
  try {
    const hello = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    assert.equal(
      (hello as { readonly result: { readonly ok: boolean } }).result.ok,
      true,
      "build drift is diagnostic state, not a rejected handshake",
    );
    const warning = (
      hello as {
        readonly result: {
          readonly warning: {
            readonly code: string;
            readonly liveRuntimeSessions: number;
            readonly pendingWrites: number;
          };
        };
      }
    ).result.warning;
    assert.equal(warning.code, "daemon_build_stale");
    assert.equal(warning.liveRuntimeSessions, 2);
    assert.equal(warning.pendingWrites, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 0, "the handshake must never stop a daemon with work still in flight");
  } finally {
    server.close();
  }
});
