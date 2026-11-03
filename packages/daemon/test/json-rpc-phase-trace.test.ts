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

function server(sink: DaemonOperationObserver, slowStatusMs: number) {
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
        return { daemonId: "phase-fixture", pid: process.pid, repos: [], summary: "fixture" };
      },
    } as unknown as DaemonHost,
    build: { loadedBuildId: null, commit: null, builtAt: null },
    authContext,
    emit: async () => undefined,
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
