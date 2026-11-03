// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  markDaemonOperationPhase,
  type DaemonOperationObserver,
  type DaemonOperationTrace,
} from "../src/daemon-operation.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

function observer() {
  const traces: DaemonOperationTrace[] = [];
  const sink: DaemonOperationObserver = {
    begin: () => ({
      update: () => undefined,
      end: (trace) => {
        if (trace) traces.push(trace);
      },
    }),
  };
  return { sink, traces };
}

function server(
  sink: DaemonOperationObserver,
  slowStatusMs: number,
  largePayload = 0,
  recordTraffic?: (entry: Record<string, unknown>) => void,
) {
  const authContext: DaemonAuthenticationContext = {
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" },
  };
  return createJsonRpcProtocolServer({
    operationObserver: sink,
    host: {
      status: () => {
        markDaemonOperationPhase("projection-read");
        const until = performance.now() + slowStatusMs;
        while (performance.now() < until) {
          /* deliberately slow read stage */
        }
        return {
          daemonId: "phase-fixture",
          pid: process.pid,
          repos: [],
          summary: "fixture",
          ...(largePayload > 0 ? { padding: "x".repeat(largePayload) } : {}),
        };
      },
    } as unknown as DaemonHost,
    build: { loadedBuildId: null, commit: null, builtAt: null },
    authContext,
    emit: async () => undefined,
    ...(recordTraffic ? { recordTraffic } : {}),
  });
}

test("the JSON-RPC dispatch attributes a deliberately slow stage to its marker", async () => {
  const observed = observer(),
    protocol = server(observed.sink, 80);
  await protocol.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const response = await protocol.handle({ jsonrpc: "2.0", id: 2, method: "daemon.status", params: {} });
  assert.equal((response as { result?: { ok?: boolean } }).result?.ok, true);
  const trace = observed.traces.find((entry) => entry.phases.some((phase) => phase.name === "projection-read"))!;
  const slow = trace.phases.find((phase) => phase.name === "projection-read")!;
  assert.ok(slow.endedAtMs - slow.startedAtMs >= 70, JSON.stringify(trace.phases));
  assert.deepEqual(
    trace.phases.slice(0, 4).map((phase) => phase.name),
    ["authentication", "authorization", "repository-admission", "projection-read"],
  );
  assert.ok(trace.phases.some((phase) => phase.name === "serialization"));
  assert.match(trace.traceId, /^[0-9a-f]{32}$/u);
  assert.match(trace.spanId, /^[0-9a-f]{16}$/u);
});

test("serialization owns JSON encoding and reply owns the transport write", async () => {
  const observed = observer(),
    protocol = server(observed.sink, 0, 2 * 1024 * 1024);
  await protocol.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const response = await protocol.handle(
    { jsonrpc: "2.0", id: 2, method: "daemon.status", params: {} },
    {
      frameReceivedAt: Date.now(),
      frameBytes: 123,
      writeResponse: () => {
        const until = performance.now() + 25;
        while (performance.now() < until) {
          /* simulate a slow socket write */
        }
        return 0;
      },
    },
  );
  assert.ok(response);
  const trace = observed.traces.at(-1)!,
    serialization = trace.phases.find((phase) => phase.name === "serialization")!,
    reply = trace.phases.find((phase) => phase.name === "reply")!;
  assert.ok(serialization.endedAtMs - serialization.startedAtMs > 0, JSON.stringify(trace.phases));
  assert.ok(reply.endedAtMs - reply.startedAtMs >= 20, JSON.stringify(trace.phases));
  assert.ok(reply.startedAtMs >= serialization.endedAtMs);
  assert.equal(trace.requestBytes, 123);
  assert.ok(trace.replyBytes > 2 * 1024 * 1024);
});

test("JSON-RPC traffic records the frame bytes and the encoded reply bytes on the operation", async () => {
  const observed = observer(),
    traffic: Record<string, unknown>[] = [],
    protocol = server(observed.sink, 0, 0, (entry) => traffic.push(entry));
  await protocol.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  await protocol.handle(
    { jsonrpc: "2.0", id: 2, method: "daemon.status", params: {} },
    { frameReceivedAt: Date.now(), frameBytes: 321, writeResponse: () => 0 },
  );
  const entry = traffic.at(-1)!;
  assert.equal(entry.requestBytes, 321);
  assert.ok(Number(entry.replyBytes) > 0);
  assert.equal(entry.nodeId, null);
});
