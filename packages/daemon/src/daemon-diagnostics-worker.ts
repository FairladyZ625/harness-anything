import { Worker, parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { createUnixSocketTransportServer } from "./transport/unix-socket.ts";
import { daemonHelloMismatch } from "./client/daemon-hello.ts";
import { daemonBuildStamp } from "./build-identity.ts";
import { daemonDiagnosticsEndpoint } from "./client/local-daemon-target.ts";
import { openDaemonLifecycleLog } from "./lifecycle-log.ts";
import { readDaemonOperationTable } from "./daemon-operation-table.ts";
import type { DaemonDiagnosticsOptions } from "./daemon-diagnostics.ts";
import type { JsonObject, JsonValue, JsonRpcRequest, JsonRpcResponse } from "./protocol/json-rpc-types.ts";

const options = workerData as DaemonDiagnosticsOptions & {
    heartbeat: SharedArrayBuffer;
    operations: SharedArrayBuffer;
  },
  heartbeat = new BigInt64Array(options.heartbeat),
  operations = readDaemonOperationTable(options.operations),
  log = openDaemonLifecycleLog({ ...options, logKind: "diagnostics" }),
  threshold = options.stallThresholdMs ?? 2_000;
let metrics: JsonObject | null = null,
  activeStall: Record<string, JsonValue> | null = null,
  stallStartedMonotonic = 0,
  lastMetricsReceivedAt = 0;
const recentStalls: Record<string, JsonValue>[] = [];
const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const age = (): number => Math.max(0, nowMs() - Number(Atomics.load(heartbeat, 0)));
const record = (event: string, detail: JsonObject): void =>
  log.record({ event: "diagnostics", reason: event, ...detail });
const snapshot = (): JsonObject => {
  const state = ["starting", "running", "draining", "stopping"][Number(Atomics.load(heartbeat, 1))]!,
    heartbeatAgeMs = age(),
    inFlight = operations.snapshot();
  return {
    ok: true,
    command: "daemon-status",
    daemonId: options.daemonId,
    pid: process.pid,
    state,
    stalled: heartbeatAgeMs >= threshold,
    heartbeatAgeMs,
    inFlight: inFlight as unknown as JsonObject[],
    waitingFor:
      state === "draining" || state === "stopping"
        ? inFlight.map((op) => ({
            method: op.method,
            repoId: op.repoId,
            phase: op.phase,
            startedAt: op.startedAt,
          }))
        : [],
    recentStalls,
    metrics,
    mainSampleAgeMs: metrics ? Math.max(0, Date.now() - Date.parse(String(metrics.sampledAt))) : null,
    rss: process.memoryUsage.rss(),
    summary:
      `daemon status: pid=${process.pid} state=${state} heartbeatAgeMs=${heartbeatAgeMs} inFlight=${inFlight.length}\n` +
      inFlight
        .slice(0, 20)
        .map((op) => `${op.method} repo=${op.repoId ?? "none"} phase=${op.phase} since=${op.startedAt}`)
        .join("\n"),
  };
};

// Inspector commands may wait for a native main-thread call. Give the attempt its own worker so
// neither session setup nor disconnection can hold the watchdog's diagnostic socket.
function captureStack(stall: Record<string, JsonValue>): void {
  const collector = new Worker(new URL(`./daemon-stack-worker${path.extname(import.meta.filename)}`, import.meta.url));
  let finished = false;
  const finish = (status: string, stack: JsonValue = []): void => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    stall.stackStatus = status;
    stall.stack = stack;
    record("stall_stack", { startedAt: stall.startedAt!, stackStatus: status, stack });
    void collector.terminate();
  };
  const deadline = setTimeout(() => finish("unavailable_before_deadline"), 1_000);
  collector.once("message", (result) => finish(result.status, result.stack));
  collector.once("error", (error) => finish(`unavailable: ${error.message}`));
  collector.once("exit", (code) => finish(`collector_exited: ${code}`));
}

const timer = setInterval(() => {
  const heartbeatAgeMs = age();
  if (!activeStall && heartbeatAgeMs >= threshold) {
    stallStartedMonotonic = nowMs() - heartbeatAgeMs;
    activeStall = {
      startedAt: new Date(Date.now() - heartbeatAgeMs).toISOString(),
      detectedAt: new Date().toISOString(),
      heartbeatAgeMs,
      inFlight: operations.snapshot() as unknown as JsonObject[],
      metrics,
      rss: process.memoryUsage.rss(),
      stackStatus: "pending",
    };
    recentStalls.push(activeStall);
    if (recentStalls.length > 8) recentStalls.shift();
    record("stall_started", activeStall);
    captureStack(activeStall);
  } else if (activeStall && heartbeatAgeMs < threshold) {
    activeStall.endedAt = new Date().toISOString();
    activeStall.durationMs = Math.max(0, nowMs() - stallStartedMonotonic);
    record("stall_ended", activeStall);
    activeStall = null;
  }
}, options.heartbeatMs ?? 250);
const recordMetrics = (): void =>
  record("metrics", {
    metrics,
    rss: process.memoryUsage.rss(),
    heartbeatAgeMs: age(),
    inFlight: operations.activeCount,
    recentStalls: recentStalls.length,
  });
const metricsTimer = setInterval(() => {
  // During a main-thread stall no sample arrives; keep recording independent liveness and RSS.
  if (nowMs() - lastMetricsReceivedAt >= (options.metricsIntervalMs ?? 10_000)) recordMetrics();
}, options.metricsIntervalMs ?? 10_000);

const transport = createUnixSocketTransportServer({
  daemonId: options.daemonId,
  socketPath: daemonDiagnosticsEndpoint(options.endpoint),
  createProtocolServer: () => {
    const one = (request: JsonRpcRequest): JsonRpcResponse => {
      if (request.method !== "protocol.hello" && request.method !== "daemon.status")
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32601, message: "Read-only daemon diagnostics" },
        };
      if (request.method === "protocol.hello" && request.params?.executionCredential !== undefined)
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32600, message: "Local owner diagnostics only" },
        };
      if (request.method === "protocol.hello") {
        const mismatch = daemonHelloMismatch(request.params?.protocolVersion);
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: mismatch
            ? { ok: false, code: mismatch.code, error: { hint: mismatch.message } }
            : { ok: true, protocolVersion: request.params!.protocolVersion!, build: { ...daemonBuildStamp() } },
        };
      }
      return { jsonrpc: "2.0", id: request.id ?? null, result: snapshot() };
    };
    return { handle: async (request) => (Array.isArray(request) ? request.map(one) : one(request)), close: () => {} };
  },
});
await transport.start();
parentPort!.on("message", (message) => {
  if (message.type === "metrics") {
    metrics = message.metrics;
    lastMetricsReceivedAt = nowMs();
    // Persist each completed histogram window before a newer one can overwrite its peak.
    recordMetrics();
  } else if (message.type === "close") {
    clearInterval(timer);
    clearInterval(metricsTimer);
    void transport.stop().then(() => parentPort!.close());
  }
});
parentPort!.postMessage({ ready: true });
