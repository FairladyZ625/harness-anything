// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";

interface ParkedWaitServerInput {
  readonly connectionSignal?: AbortSignal;
  readonly started: (method: string) => void;
  readonly settled: (method: string) => void;
}

// The host's await never settles on its own: every resolution in these tests comes from the
// parked-wait abandonment paths under test.
function parkedAwaitServer(input: ParkedWaitServerInput) {
  const host = {
    awaitRuntimeSessions: () => new Promise<never>(() => undefined),
    read: async () => ({
      schema: "daemon-observe-tail/v1",
      ok: true,
      repoId: "parked-wait",
      mode: "local",
      kind: "lifecycle",
      direction: "history",
      status: "ready",
      items: [],
      historyCursor: null,
      liveCursor: null,
      sourceCursor: null,
      done: true,
    }),
    status: () => ({ daemonId: "parked-wait", pid: process.pid, repos: [] }),
  } as never as DaemonHost;
  return createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: {
      transportKind: "unix-socket",
      ...(input.connectionSignal ? { connectionSignal: input.connectionSignal } : {}),
    },
    emit: async () => undefined,
    onRequestStarted: input.started,
    onRequestSettled: input.settled,
  });
}

const helloRequest = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  },
  awaitRequest = (id: number) => ({
    jsonrpc: "2.0" as const,
    id,
    method: "repo.agentRuntime.sessions.await",
    params: { repo: { repoId: "parked-wait" }, payload: { runtimeSessionIds: ["sess-parked"] } },
  });

test(
  "a parked sessions.await is not counted as active request work and settles at teardown",
  { timeout: 5_000 },
  async () => {
    const started: string[] = [],
      settled: string[] = [],
      server = parkedAwaitServer({
        started: (method) => started.push(method),
        settled: (method) => settled.push(method),
      });
    try {
      await server.handle(helloRequest);
      const parked = server.handle(awaitRequest(2));
      await new Promise((resolve) => setImmediate(resolve));
      // Only hello is work: the parked wait observes external settlement, so counting it would pin a
      // superseded daemon resident for as long as any --wait client cares to watch.
      assert.deepEqual(started, ["protocol.hello"]);
      assert.deepEqual(settled, ["protocol.hello"]);
      server.close();
      // Teardown settles the parked wait with silence: no reply frame, because the transport close is
      // the answer and the client re-issues this idempotent read after reconnecting.
      assert.equal(await parked, undefined);
      assert.deepEqual(settled, ["protocol.hello"], "an abandoned wait is not work, so it never settles as a request");
    } finally {
      server.close();
    }
  },
);

test(
  "a parked sessions.await is abandoned when the connection that asked for it closes",
  { timeout: 5_000 },
  async () => {
    const connection = new AbortController(),
      started: string[] = [],
      server = parkedAwaitServer({
        connectionSignal: connection.signal,
        started: (method) => started.push(method),
        settled: () => undefined,
      });
    try {
      await server.handle(helloRequest);
      const parked = server.handle(awaitRequest(2));
      await new Promise((resolve) => setImmediate(resolve));
      connection.abort();
      assert.equal(await parked, undefined, "a closed connection settles the parked wait without a reply");
      assert.deepEqual(started, ["protocol.hello"]);
    } finally {
      server.close();
    }
  },
);

test(
  "observe.tail is treated as an observation and does not count toward active request work",
  { timeout: 5_000 },
  async () => {
    const started: string[] = [],
      settled: string[] = [],
      server = parkedAwaitServer({
        started: (method) => started.push(method),
        settled: (method) => settled.push(method),
      });
    try {
      await server.handle(helloRequest);
      const tailResponse = await server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "observe.tail",
        params: { repo: { repoId: "parked-wait" }, payload: { kind: "lifecycle", direction: "history" } },
      });
      assert.ok(tailResponse?.result?.ok);
      // Only hello was counted as active work; observe.tail bypassed onRequestStarted/onRequestSettled.
      assert.deepEqual(started, ["protocol.hello"]);
      assert.deepEqual(settled, ["protocol.hello"]);
    } finally {
      server.close();
    }
  },
);
