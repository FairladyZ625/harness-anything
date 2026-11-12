import { observeWorkerMemory, labelWorkerMemory } from "./daemon-diagnostics-memory.ts";
import { Worker, parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { createUnixSocketTransportServer } from "./transport/unix-socket.ts";
import { daemonHelloMismatch } from "./client/daemon-hello.ts";
import { daemonBuildStamp } from "./build-identity.ts";
import { daemonDiagnosticsEndpoint } from "./client/local-daemon-target.ts";
import { openDaemonLifecycleLog } from "./lifecycle-log.ts";
import type { DaemonDiagnosticsOptions } from "./daemon-diagnostics.ts";
import { readDaemonOperationTable, type DaemonOperationInFlight } from "./daemon-operation-table.ts";
import { readDaemonTraceCompletions, type DaemonTraceCompletion } from "./daemon-trace-completions.ts";
import type { JsonObject, JsonValue, JsonRpcRequest, JsonRpcResponse } from "./protocol/json-rpc-types.ts";
import {
  countSecondBuckets,
  pruneNodeBuckets,
  pruneSecondBuckets,
  retainedNodeSeconds,
  TRACE_BUCKET_WINDOW_SECONDS,
} from "./daemon-trace-buckets.ts";

observeWorkerMemory();

const SAMPLE_WINDOW_MS = 60_000,
  SAMPLES_PER_METHOD = 1_024,
  MAX_METHODS = 256,
  MAX_NODES = 256,
  MAX_SLOWEST = 16;
interface CompletedSample {
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly ok: boolean;
}
interface QueueState {
  queueDepth: number | null;
  atMs: number;
}
interface SlowSample {
  readonly method: string;
  readonly durationMs: number;
  readonly at: string;
  readonly ok: boolean;
  readonly nodeId: string | null;
}
const options = workerData as DaemonDiagnosticsOptions & {
    heartbeat: SharedArrayBuffer;
    operations: SharedArrayBuffer;
    completions: SharedArrayBuffer;
  },
  heartbeat = new BigInt64Array(options.heartbeat),
  operations = readDaemonOperationTable(options.operations),
  completions = readDaemonTraceCompletions(options.completions),
  completedByMethod = new Map<string, CompletedSample[]>(),
  perSecond = new Map<number, number>(),
  nodeSecond = new Map<string, Map<number, number>>(),
  writeQueues = new Map<string, QueueState>(),
  slowest: SlowSample[] = [],
  log = openDaemonLifecycleLog({ ...options, logKind: "diagnostics" }),
  threshold = options.stallThresholdMs ?? 2_000;
let metrics: JsonObject | null = null,
  activeStall: Record<string, JsonValue> | null = null,
  stallStartedMonotonic = 0,
  lastMetricsReceivedAt = 0,
  completedCount = 0,
  errorCount = 0;
const slowThresholdMs = 1_000;
const recentStalls: Record<string, JsonValue>[] = [];
const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const age = (): number => Math.max(0, nowMs() - Number(Atomics.load(heartbeat, 0)));
const record = (event: string, detail: JsonObject): void =>
  log.record({ event: "diagnostics", reason: event, ...detail });
const snapshot = (): JsonObject => {
  const state = ["starting", "running", "draining", "stopping"][Number(Atomics.load(heartbeat, 1))]!,
    heartbeatAgeMs = age(),
    trace = traceSnapshot(),
    inFlight = operations.snapshot().map((op) => inFlightOperation(op)) as unknown as JsonObject[];
  return {
    ok: true,
    command: "daemon-status",
    daemonId: options.daemonId,
    pid: process.pid,
    state,
    stalled: heartbeatAgeMs >= threshold,
    heartbeatAgeMs,
    inFlight,
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
    trace,
    mainSampleAgeMs: metrics ? Math.max(0, Date.now() - Date.parse(String(metrics.sampledAt))) : null,
    rss: process.memoryUsage.rss(),
    summary:
      `daemon status: pid=${process.pid} state=${state} heartbeatAgeMs=${heartbeatAgeMs} inFlight=${operations.activeCount}\n` +
      operations
        .snapshot()
        .slice(0, 20)
        .map((op) => `${op.method} repo=${op.repoId ?? "none"} phase=${op.phase} since=${op.startedAt}`)
        .join("\n"),
  };
};

// Inspector commands may wait for a native main-thread call. Give the attempt its own worker so
// neither session setup nor disconnection can hold the watchdog's diagnostic socket.
function captureStack(stall: Record<string, JsonValue>): void {
  const collector = new Worker(new URL(`./daemon-stack-worker${path.extname(import.meta.filename)}`, import.meta.url), {
    name: "stack-collector",
  });
  labelWorkerMemory(collector, "stack-collector");
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

function traceSnapshot(): JsonObject {
  completions.drain(recordCompletion);
  const now = nowMs(),
    since = now - SAMPLE_WINDOW_MS,
    nowSecond = Math.floor(now / 1_000);
  pruneSecondBuckets(perSecond, nowSecond);
  pruneNodeBuckets(nodeSecond, nowSecond);
  const last1 = countSecondBuckets(perSecond, now - 1_000),
    last5 = countSecondBuckets(perSecond, now - 5_000),
    last60 = countSecondBuckets(perSecond, since),
    byMethod = [...completedByMethod.entries()]
      .flatMap(([method, samples]) => {
        const recent = samples.filter((sample) => sample.endedAtMs >= since);
        if (recent.length === 0) return [];
        return [{ method, count: recent.length, ...percentiles(recent) }];
      })
      .sort((left, right) => right.count - left.count)
      .slice(0, 64),
    byNode = [...nodeSecond.entries()]
      .flatMap(([nodeId, seconds]) => {
        const count = countSecondBuckets(seconds, since);
        return count === 0 ? [] : [{ nodeId, requests: count }];
      })
      .sort((left, right) => right.requests - left.requests)
      .slice(0, MAX_NODES);
  return {
    windowMs: SAMPLE_WINDOW_MS,
    requestsPerSecond: {
      last1s: last1,
      last5s: Math.round((last5 / 5) * 100) / 100,
      last60s: Math.round((last60 / 60) * 100) / 100,
    },
    completed: completedCount,
    droppedCompletions: completions.dropped,
    errors: errorCount,
    inFlight: operations.activeCount,
    byMethod,
    byNode,
    writeQueues: [...writeQueues.entries()]
      .map(([repoId, state]) => ({ repoId, queueDepth: state.queueDepth, ageMs: Math.max(0, now - state.atMs) }))
      .sort((left, right) => left.repoId.localeCompare(right.repoId)),
    slowest: [...slowest].sort((left, right) => right.durationMs - left.durationMs) as unknown as JsonValue,
    slowThresholdMs,
    bucketWindowSeconds: TRACE_BUCKET_WINDOW_SECONDS,
    retainedNodeSeconds: retainedNodeSeconds(nodeSecond),
  };
}

function percentiles(samples: readonly CompletedSample[]) {
  const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right),
    at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  return {
    p50Ms: at(0.5),
    p99Ms: Math.min(at(0.99), sorted.at(-1) ?? 0),
    maxMs: sorted.at(-1) ?? 0,
    errors: samples.filter((sample) => !sample.ok).length,
  };
}

function recordCompletion(operation: DaemonTraceCompletion): void {
  const { durationMs, endedAtMs } = operation,
    second = Math.floor(endedAtMs / 1_000),
    samples = completedByMethod.get(operation.method) ?? [],
    ok = operation.ok;
  samples.push({ endedAtMs, durationMs, ok });
  if (samples.length > SAMPLES_PER_METHOD) samples.splice(0, samples.length - SAMPLES_PER_METHOD);
  completedByMethod.set(operation.method, samples);
  if (completedByMethod.size > MAX_METHODS) {
    const oldest = [...completedByMethod.entries()].sort(
      (left, right) => (left[1][0]?.endedAtMs ?? 0) - (right[1][0]?.endedAtMs ?? 0),
    )[0];
    if (oldest) completedByMethod.delete(oldest[0]);
  }
  perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  pruneSecondBuckets(perSecond, second);
  const nodeId = operation.nodeId ?? "local",
    nodeBuckets = nodeSecond.get(nodeId) ?? new Map<number, number>();
  nodeBuckets.set(second, (nodeBuckets.get(second) ?? 0) + 1);
  nodeSecond.set(nodeId, nodeBuckets);
  pruneSecondBuckets(nodeBuckets, second);
  if (nodeSecond.size > MAX_NODES) {
    const oldest = [...nodeSecond.entries()].sort(
      (left, right) => (left[1].keys().next().value ?? 0) - (right[1].keys().next().value ?? 0),
    )[0];
    if (oldest) nodeSecond.delete(oldest[0]);
  }
  completedCount += 1;
  if (!ok) errorCount += 1;
  if (durationMs >= slowThresholdMs) {
    slowest.push({
      method: operation.method,
      durationMs,
      at: new Date().toISOString(),
      ok,
      nodeId: operation.nodeId,
    });
    slowest.sort((left, right) => right.durationMs - left.durationMs);
    if (slowest.length > MAX_SLOWEST) slowest.length = MAX_SLOWEST;
  }
}

function inFlightOperation(operation: DaemonOperationInFlight): JsonObject {
  return { ...operation, elapsedMs: Math.max(0, Date.now() - Date.parse(operation.startedAt)) };
}

const timer = setInterval(() => {
  completions.drain(recordCompletion);
  const heartbeatAgeMs = age();
  if (!activeStall && heartbeatAgeMs >= threshold) {
    stallStartedMonotonic = nowMs() - heartbeatAgeMs;
    const trace = traceSnapshot(),
      inFlight = operations.snapshot().map((op) => inFlightOperation(op)) as unknown as JsonObject[];
    activeStall = {
      startedAt: new Date(Date.now() - heartbeatAgeMs).toISOString(),
      detectedAt: new Date().toISOString(),
      heartbeatAgeMs,
      inFlight,
      metrics,
      trace,
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
interface DiagnosticsWorkerMessage {
  readonly type: string;
  readonly metrics?: JsonObject;
}
const handleMessage = (message: DiagnosticsWorkerMessage): void => {
  if (message.type === "metrics") {
    if (message.metrics === undefined) return;
    metrics = message.metrics;
    if (Array.isArray(metrics.writeQueues)) {
      for (const queue of metrics.writeQueues) {
        if (typeof queue?.repoId !== "string") continue;
        writeQueues.set(queue.repoId, {
          queueDepth: typeof queue.queueDepth === "number" ? queue.queueDepth : null,
          atMs: nowMs(),
        });
      }
    }
    lastMetricsReceivedAt = nowMs();
    // Persist each completed histogram window before a newer one can overwrite its peak.
    recordMetrics();
  } else if (message.type === "close") {
    clearInterval(timer);
    clearInterval(metricsTimer);
    void transport.stop().then(() => parentPort!.close());
  }
};
parentPort!.on("message", (message: { type: string; messages?: unknown[] }) => {
  if (message.type === "batch" && Array.isArray(message.messages)) {
    for (const item of message.messages) handleMessage(item as DiagnosticsWorkerMessage);
    return;
  }
  handleMessage(message as DiagnosticsWorkerMessage);
});
parentPort!.postMessage({ ready: true });
