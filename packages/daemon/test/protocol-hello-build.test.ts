// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { daemonHelloMismatch } from "../src/client/daemon-hello.ts";
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
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: build.commit },
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
  let shutdowns = 0,
    driftObservations = 0;
  const server = createJsonRpcProtocolServer({
    host: { status: () => ({ summary: "daemon status", repos: [] }) } as never,
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
    onBuildDriftObserved: () => {
      driftObservations += 1;
    },
    buildDrainStatus: () => ({ liveRuntimeSessions: 2, pendingWrites: 1, attachingRepositories: 1 }),
  });
  try {
    const hello = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: "loaded" },
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
    assert.equal(driftObservations, 1, "hello observes drift even without the optional diagnostic flag");
    const status = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.status", params: {} });
    assert.equal((status as { readonly result: { readonly ok: boolean } }).result.ok, true);
    assert.equal(driftObservations, 2, "ordinary requests observe drift on long-lived connections");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 0, "the handshake must never stop a daemon with work still in flight");
  } finally {
    server.close();
  }
});

for (const clientCommit of [undefined, "other-release"]) {
  test(`protocol.hello accepts ${clientCommit ?? "missing"} build metadata within the protocol window`, async () => {
    let stops = 0;
    const server = createJsonRpcProtocolServer({
      host: {} as never,
      build: { commit: "fixed-release" },
      authContext: { transportKind: "unix-socket" },
      emit: async () => undefined,
      requestShutdown: () => {
        stops += 1;
      },
    });
    try {
      const hello = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "protocol.hello",
        params: {
          protocolVersion: currentDaemonProtocolVersion,
          ...(clientCommit ? { buildCommit: clientCommit } : {}),
        },
      });
      assert.equal((hello as { result: { ok: boolean } }).result.ok, true, JSON.stringify(hello));
      const stop = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
      assert.equal((stop as { result: { ok: boolean } }).result.ok, true);
      assert.equal(stops, 1);
    } finally {
      server.close();
    }
  });
}
test("a second refused hello revokes previously admitted business requests", async () => {
  let stops = 0;
  const server = createJsonRpcProtocolServer({
    host: {} as never,
    build: { commit: "fixed-release" },
    authContext: { transportKind: "unix-socket" },
    emit: async () => undefined,
    requestShutdown: () => {
      stops += 1;
    },
  });
  try {
    for (const protocolVersion of [
      currentDaemonProtocolVersion,
      { major: currentDaemonProtocolVersion.major + 1, minor: 0 },
    ])
      await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "protocol.hello",
        params: { protocolVersion, buildCommit: "fixed-release" },
      });
    const stop = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
    assert.equal((stop as { result: { code: string } }).result.code, "hello_required");
    assert.equal(stops, 0);
  } finally {
    server.close();
  }
});

// A malformed hello must revoke the earlier admission too: validation runs before dispatch.
test("a malformed second hello cannot leave an earlier handshake admitted", async () => {
  let stops = 0;
  const server = createJsonRpcProtocolServer({
    host: {} as never,
    build: { commit: "fixed-release" },
    authContext: { transportKind: "unix-socket" },
    emit: async () => undefined,
    requestShutdown: () => {
      stops += 1;
    },
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: "fixed-release" },
    });
    const malformed = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "protocol.hello",
      params: { protocolVersion: { major: "wrong", minor: 0 } },
    });
    assert.equal((malformed as { result: { ok: boolean } }).result.ok, false);
    const stop = await server.handle({ jsonrpc: "2.0", id: 3, method: "daemon.stop", params: {} });
    assert.equal((stop as { result: { code: string } }).result.code, "hello_required");
    assert.equal(stops, 0);
  } finally {
    server.close();
  }
});

// CH1: build identities diagnose skew; admission belongs to the bounded protocol window.
test("different builds with the same protocol can issue daemon commands", async () => {
  let stops = 0;
  const server = createJsonRpcProtocolServer({
    host: {} as never,
    build: { commit: "release-B" },
    authContext: { transportKind: "unix-socket" },
    emit: async () => undefined,
    requestShutdown: () => {
      stops += 1;
    },
  });
  try {
    const hello = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: "release-A" },
    });
    assert.equal((hello as { result: { ok: boolean } }).result.ok, true, JSON.stringify(hello));
    assert.equal((hello as { result: { build: { commit: string } } }).result.build.commit, "release-B");
    await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.stop", params: {} });
    assert.equal(stops, 1);
  } finally {
    server.close();
  }
});

test("protocol window accepts current and previous minor only, never another major", () => {
  const supported = { major: 1, minor: 2 };
  for (const minor of [1, 2]) assert.equal(daemonHelloMismatch({ major: 1, minor }, supported), null);
  for (const peer of [
    { major: 1, minor: 0 },
    { major: 1, minor: 3 },
    { major: 2, minor: 2 },
    { major: 1, minor: -1 },
    { major: 1, minor: 1.5 },
  ])
    assert.equal(daemonHelloMismatch(peer, supported)?.code, "incompatible_protocol_version");
  assert.equal(
    daemonHelloMismatch({ major: 1, minor: -1 }, { major: 1, minor: 0 })?.code,
    "incompatible_protocol_version",
  );
});
