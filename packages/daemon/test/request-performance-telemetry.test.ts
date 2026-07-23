// harness-test-tier: fast
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Effect } from "effect";
import {
  type DaemonAdmissionBudget,
  type WriteCoordinator,
  type WriteOp
} from "@harness-anything/kernel";
import {
  makeDaemonLogService,
  type DaemonLogEntryV1
} from "@harness-anything/application";
import {
  createDaemonRequestPerformanceTrace,
  currentDaemonRequestPerformanceTrace,
  measureCurrentDaemonRequestPerformancePhase,
  runWithDaemonRequestPerformanceTrace,
  serializeDaemonRequestPerformanceSummary,
  setCurrentDaemonRequestPerformanceTerminalSink,
  type DaemonRequestPerformanceSummary
} from "../src/observability/request-performance.ts";
import { DaemonWriteQueue } from "../src/runtime/write-queue.ts";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/method-registry.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/protocol/json-rpc-types.ts";

test("request performance trace is deterministic, bounded, and terminal exactly once", async () => {
  let now = 102;
  const terminal: DaemonRequestPerformanceSummary[] = [];
  const trace = createDaemonRequestPerformanceTrace({
    method: "repo.command.run",
    requestId: "github_pat_secret-shaped-request-id",
    receivedAtMs: 100,
    now: () => now
  });
  trace.setTerminalSink((summary) => terminal.push(summary));
  trace.record("transport-queue", 2);

  await runWithDaemonRequestPerformanceTrace(trace, async () => {
    const endHandler = trace.begin("handler");
    now = 105;
    await measureCurrentDaemonRequestPerformancePhase("service", async () => {
      now = 111;
    });
    now = 116;
    endHandler();
  });
  now = 120;
  const summary = trace.finish("response-written", 9.876, 0.493827);
  trace.finish("handler-error", 99);
  await Promise.resolve();

  assert.equal(terminal.length, 1);
  assert.equal(summary.totalMs, 20);
  assert.match(summary.requestId, /^sha256:[a-f0-9]{24}$/u);
  assert.equal(summary.eventLoopActiveMs, 9.88);
  assert.equal(summary.eventLoopUtilization, 0.4938);
  assert.equal(summary.phasesMs["transport-queue"], 2);
  assert.equal(summary.phasesMs.handler, 14);
  assert.equal(summary.phasesMs.service, 6);
  assert.equal(summary.phasesMs.git, null);
  assert.equal(summary.phasesMs.fsync, null);
  assert.deepEqual(summary.phaseOrder, ["received", "transport-queue", "handler", "service"]);
  const message = serializeDaemonRequestPerformanceSummary(summary);
  assert.ok(Buffer.byteLength(message, "utf8") < 4_096);
  assert.equal(message.includes("payload"), false);
  assert.equal(message.includes("/Users/"), false);
  assert.equal(message.includes("github_pat_secret-shaped-request-id"), false);
});

test("nested phase timing records outer wall time without double counting", () => {
  let now = 0;
  const trace = createDaemonRequestPerformanceTrace({
    method: "repo.command.run",
    requestId: "nested-phase",
    receivedAtMs: 0,
    now: () => now
  });
  const endOuter = trace.begin("materializer");
  now = 2;
  const endInner = trace.begin("materializer");
  now = 6;
  endInner();
  now = 8;
  endOuter();

  assert.equal(trace.finish("response-written").phasesMs.materializer, 8);
});

test("JSON-RPC stream emits terminal telemetry after success and handler failure", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const lines = createInterface({ input: serverToClient });
  const frames = lines[Symbol.asyncIterator]();
  const terminal: DaemonRequestPerformanceSummary[] = [];
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: () => ({
      handle: async (message) => {
        setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
        const request = message as JsonRpcRequest;
        if (request.method === "repo.fail") throw new Error("sensitive handler detail");
        return { jsonrpc: "2.0", id: request.id ?? null, result: { ok: true } };
      }
    })
  });

  clientToServer.write(`${JSON.stringify(request("ok", "repo.ok"))}\n`);
  assert.deepEqual(JSON.parse(String((await frames.next()).value)), {
    jsonrpc: "2.0",
    id: "ok",
    result: { ok: true }
  });
  clientToServer.write(`${JSON.stringify(request("failed", "repo.fail"))}\n`);
  assert.deepEqual(JSON.parse(String((await frames.next()).value)), {
    jsonrpc: "2.0",
    id: "failed",
    error: { code: -32603, message: "sensitive handler detail" }
  });
  await waitFor(() => terminal.length === 2);

  assert.equal(terminal.length, 2);
  assert.deepEqual(terminal.map(({ outcome }) => outcome), ["response-written", "handler-error"]);
  assert.equal(new Set(terminal.map(({ requestId }) => requestId)).size, 2);
  assert.ok(terminal.every(({ requestId }) => /^sha256:[a-f0-9]{24}$/u.test(requestId)));
  assert.ok(terminal.every((summary) => summary.phasesMs.handler !== null));
  assert.ok(terminal.every((summary) => summary.phasesMs.response !== null));
  assert.ok(terminal.every((summary) => !serializeDaemonRequestPerformanceSummary(summary).includes("sensitive handler detail")));
  lines.close();
  await connection.close();
});

test("asynchronous response write failure emits one terminal performance record", async () => {
  const clientToServer = new PassThrough();
  const errors: Error[] = [];
  const serverToClient = new Writable({
    write: (_chunk, _encoding, callback) => {
      setImmediate(() => callback(new Error("simulated asynchronous write failure")));
    }
  });
  const terminal: DaemonRequestPerformanceSummary[] = [];
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: () => ({
      handle: async (message) => {
        setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
        const request = message as JsonRpcRequest;
        return { jsonrpc: "2.0", id: request.id ?? null, result: { ok: true } };
      }
    }),
    onError: (error) => errors.push(error)
  });

  clientToServer.write(`${JSON.stringify(request("write-failed", "repo.ok"))}\n`);
  await waitFor(() => terminal.length === 1);

  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.outcome, "response-write-error");
  assert.ok(errors.some((error) => error.message.includes("asynchronous write failure")));
  await connection.close();
});

test("response terminal waits for writable callback settlement", async () => {
  const clientToServer = new PassThrough();
  let settleWrite: (() => void) | undefined;
  const serverToClient = new Writable({
    highWaterMark: 1,
    write: (_chunk, _encoding, callback) => {
      settleWrite = callback;
    }
  });
  const terminal: DaemonRequestPerformanceSummary[] = [];
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: () => ({
      handle: async (message) => {
        setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
        const request = message as JsonRpcRequest;
        return { jsonrpc: "2.0", id: request.id ?? null, result: { ok: true } };
      }
    })
  });

  clientToServer.write(`${JSON.stringify(request("backpressure", "repo.ok"))}\n`);
  await waitFor(() => settleWrite !== undefined);
  assert.equal(terminal.length, 0);
  settleWrite?.();
  await waitFor(() => terminal.length === 1);
  assert.equal(terminal[0]?.outcome, "response-written");
  await connection.close();
});

test("input disconnect finishes an in-flight request exactly once", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const terminal: DaemonRequestPerformanceSummary[] = [];
  let releaseHandler: (() => void) | undefined;
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: () => ({
      handle: async (message) => {
        setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        const request = message as JsonRpcRequest;
        return { jsonrpc: "2.0", id: request.id ?? null, result: { ok: true } };
      }
    })
  });

  clientToServer.write(`${JSON.stringify(request("disconnect", "repo.wait"))}\n`);
  await waitFor(() => releaseHandler !== undefined);
  clientToServer.destroy();
  await waitFor(() => terminal.length === 1);
  assert.equal(terminal[0]?.outcome, "connection-closed");
  releaseHandler?.();
  await connection.close();
  assert.equal(terminal.length, 1);
});

test("normal input EOF lets an in-flight one-shot request finish its response", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const lines = createInterface({ input: serverToClient });
  const frames = lines[Symbol.asyncIterator]();
  const terminal: DaemonRequestPerformanceSummary[] = [];
  let releaseHandler: (() => void) | undefined;
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "ssh-exec",
    authContext: { transportKind: "ssh-exec" },
    createProtocolServer: () => ({
      handle: async (message) => {
        setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        const request = message as JsonRpcRequest;
        return { jsonrpc: "2.0", id: request.id ?? null, result: { ok: true } };
      }
    })
  });

  clientToServer.end(`${JSON.stringify(request("one-shot", "repo.wait"))}\n`);
  await waitFor(() => releaseHandler !== undefined);
  assert.equal(terminal.length, 0);
  releaseHandler?.();
  assert.equal(JSON.parse(String((await frames.next()).value)).id, "one-shot");
  await waitFor(() => terminal.length === 1);
  assert.equal(terminal[0]?.outcome, "response-written");
  lines.close();
  await connection.close();
});

test("JSON-RPC batch members emit independently correlated terminal records", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const lines = createInterface({ input: serverToClient });
  const frames = lines[Symbol.asyncIterator]();
  const terminal: DaemonRequestPerformanceSummary[] = [];
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: () => ({
      handle: async (message) => {
        setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
        const request = message as JsonRpcRequest;
        return { jsonrpc: "2.0", id: request.id ?? null, result: { method: request.method } };
      }
    })
  });

  clientToServer.write(`${JSON.stringify([
    request("batch-a", "repo.a"),
    request("batch-b", "repo.b")
  ])}\n`);
  const response = JSON.parse(String((await frames.next()).value)) as JsonRpcResponse[];
  await waitFor(() => terminal.length === 2);

  assert.deepEqual(response.map(({ id }) => id), ["batch-a", "batch-b"]);
  assert.equal(new Set(terminal.map(({ requestId }) => requestId)).size, 2);
  assert.ok(terminal.every(({ outcome }) => outcome === "response-written"));
  lines.close();
  await connection.close();
});

test("the same client request id on separate connections gets distinct correlation ids", async () => {
  const terminal: DaemonRequestPerformanceSummary[] = [];
  const serve = (connectionId: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const connection = serveJsonRpcStream({
      input,
      output,
      connectionId,
      transportKind: "unix-socket",
      authContext: { transportKind: "unix-socket" },
      createProtocolServer: () => ({
        handle: async (message) => {
          setCurrentDaemonRequestPerformanceTerminalSink((summary) => terminal.push(summary));
          const request = message as JsonRpcRequest;
          return { jsonrpc: "2.0", id: request.id ?? null, result: { ok: true } };
        }
      })
    });
    return { input, output, connection };
  };
  const first = serve("connection-a");
  const second = serve("connection-b");

  first.input.write(`${JSON.stringify(request("2", "repo.same"))}\n`);
  second.input.write(`${JSON.stringify(request("2", "repo.same"))}\n`);
  await waitFor(() => terminal.length === 2);

  assert.equal(new Set(terminal.map(({ requestId }) => requestId)).size, 2);
  await Promise.all([first.connection.close(), second.connection.close()]);
});

test("write queue retains independent request traces for separately enqueued items", async () => {
  const queue = new DaemonWriteQueue(
    1,
    0,
    unlimitedAdmissionBudget()
  );
  const summaries: DaemonRequestPerformanceSummary[] = [];
  const traceA = trace("queue-a", summaries);
  const traceB = trace("queue-b", summaries);
  const coordinatorFor = (): WriteCoordinator => ({
    enqueue: (operation) => Effect.succeed({
      opId: operation.opId,
      entityId: operation.entityId,
      accepted: true
    }),
    flush: (reason) => Effect.succeed({ reason, opCount: 1, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  });

  const first = runWithDaemonRequestPerformanceTrace(traceA, () =>
    queue.enqueueInteractive(queueRequest("a"), coordinatorFor));
  const second = runWithDaemonRequestPerformanceTrace(traceB, () =>
    queue.enqueueInteractive(queueRequest("b"), coordinatorFor));
  await Promise.all([first, second]);
  traceA.finish("response-written");
  traceB.finish("response-written");
  await Promise.resolve();

  assert.equal(new Set(summaries.map(({ requestId }) => requestId)).size, 2);
  assert.ok(summaries.every(({ requestId }) => /^sha256:[a-f0-9]{24}$/u.test(requestId)));
  assert.ok(summaries.every((summary) => summary.phasesMs["queue-wait"] !== null));
  assert.ok(summaries.every((summary) => summary.phasesMs["durable-flush"] !== null));
});

test("untraced background queue work does not inherit the scheduling request trace", async () => {
  const queue = new DaemonWriteQueue(1, 0, unlimitedAdmissionBudget());
  const schedulingTrace = trace("scheduling-request", []);
  let observedTrace: unknown = "not-run";
  const traced = runWithDaemonRequestPerformanceTrace(schedulingTrace, () =>
    queue.enqueueBackground({ source: "traced", run: () => undefined }));
  const untraced = runWithDaemonRequestPerformanceTrace(undefined, () =>
    queue.enqueueBackground({
      source: "untraced",
      run: () => {
        observedTrace = currentDaemonRequestPerformanceTrace();
      }
    }));

  await Promise.all([traced, untraced]);
  assert.equal(observedTrace, undefined);
});

test("production protocol sink stores one redacted bounded performance entry after response", async () => {
  const records: DaemonLogEntryV1[] = [];
  const logService = makeDaemonLogService({
    store: {
      append: async (entry) => {
        records.push(entry);
      },
      read: async () => ({ records, droppedCount: 0 })
    },
    now: () => "2026-07-23T00:00:00.000Z",
    cursorSecret: "test-only-cursor-secret"
  });
  const repo = { repoId: "repo-performance", canonicalRoot: "/Users/private/secret-repo" };
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const lines = createInterface({ input: serverToClient });
  const frames = lines[Symbol.asyncIterator]();
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: () => createJsonRpcProtocolServer({
      daemonId: "daemon-performance-test",
      repos: [repo],
      services: {
        LocalControllerService: {} as never,
        TerminalSessionService: {} as never,
        DaemonLogService: logService
      }
    })
  });

  clientToServer.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "hello",
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion }
  })}\n`);
  await frames.next();
  clientToServer.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "performance-log",
    method: "repo.daemon.logs.list",
    params: { repo: { repoId: repo.repoId }, payload: { limit: 10 } }
  })}\n`);
  await frames.next();
  await waitFor(() => records.some((entry) => entry.event === "request.performance"));
  const page = await logService.list({ limit: 10 }, { repo });
  const performance = page.entries.filter((entry) => entry.event === "request.performance");

  assert.equal(performance.length, 1);
  assert.match(performance[0]?.requestId ?? "", /^sha256:[a-f0-9]{24}$/u);
  assert.notEqual(performance[0]?.requestId, "performance-log");
  assert.ok(Buffer.byteLength(performance[0]!.message, "utf8") < 4_096);
  assert.equal(performance[0]!.message.includes(repo.canonicalRoot), false);
  assert.equal(performance[0]!.message.includes("payload"), false);
  const summary = JSON.parse(performance[0]!.message) as DaemonRequestPerformanceSummary;
  assert.equal(summary.schema, "daemon-request-performance/v1");
  assert.equal(summary.outcome, "response-written");
  assert.ok(summary.phasesMs.handler !== null);
  assert.ok(summary.phasesMs.service !== null);
  assert.ok(summary.phasesMs.response !== null);
  lines.close();
  await connection.close();
});

function request(id: string, method: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: {} };
}

function trace(
  requestId: string,
  summaries: DaemonRequestPerformanceSummary[]
) {
  const performanceTrace = createDaemonRequestPerformanceTrace({
    method: "repo.command.run",
    requestId,
    receivedAtMs: 0,
    now: () => 1
  });
  performanceTrace.setTerminalSink((summary) => summaries.push(summary));
  return performanceTrace;
}

function queueRequest(suffix: string) {
  return {
    commandId: `command-${suffix}`,
    operationalActor: { scope: "operational" as const, kind: "system" as const, id: `actor-${suffix}` },
    ops: [{
      opId: `op-${suffix}`,
      entityId: `task/task-${suffix}`,
      kind: "doc_write",
      payload: {}
    } as WriteOp]
  };
}

function unlimitedAdmissionBudget(): DaemonAdmissionBudget {
  return {
    reserve: () => ({ ok: true, reservation: { release: () => undefined } }),
    snapshot: () => ({
      limits: {
        maxOperations: 10,
        maxBytes: 100_000,
        reservedOperationsPerPlane: 0,
        reservedBytesPerPlane: 0
      },
      used: {
        operations: 0,
        bytes: 0,
        authorityOperations: 0,
        authorityBytes: 0,
        jsonRpcOperations: 0,
        jsonRpcBytes: 0
      },
      rejected: { authority: 0, "json-rpc": 0 }
    })
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for request performance telemetry");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
