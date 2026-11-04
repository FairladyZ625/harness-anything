import { Worker } from "node:worker_threads";
import { createDaemonOperationTable } from "./daemon-operation-table.ts";
import { createDaemonTraceCompletions } from "./daemon-trace-completions.ts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DaemonOperationObserver, DaemonOperationTrace } from "./daemon-operation.ts";
import {
  frameArrivalAt,
  pruneEventLoopStallWindows,
  recordEventLoopStallWindow,
  type EventLoopStallWindow,
} from "./daemon-event-loop-stall.ts";

export interface DaemonDiagnosticsQueueRow {
  readonly repoId: string;
  readonly queueDepth: number | null;
}
export interface DaemonDiagnosticsOptions {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly endpoint: string;
  readonly heartbeatMs?: number;
  readonly stallThresholdMs?: number;
  readonly metricsIntervalMs?: number;
  /** Last-known per-repository writer queue depth; carried on the existing metrics message. */
  readonly writeQueues?: () => readonly DaemonDiagnosticsQueueRow[];
}
export async function openDaemonDiagnostics(options: DaemonDiagnosticsOptions) {
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(16)),
    operations = createDaemonOperationTable(),
    completions = createDaemonTraceCompletions(),
    histogram = monitorEventLoopDelay({ resolution: 20 }),
    extension = path.extname(fileURLToPath(import.meta.url)),
    worker = new Worker(new URL(`./daemon-diagnostics-worker${extension}`, import.meta.url), {
      workerData: {
        userRoot: options.userRoot,
        daemonId: options.daemonId,
        endpoint: options.endpoint,
        heartbeatMs: options.heartbeatMs,
        stallThresholdMs: options.stallThresholdMs,
        metricsIntervalMs: options.metricsIntervalMs,
        heartbeat: heartbeat.buffer,
        operations: operations.buffer,
        completions: completions.buffer,
      },
    });
  let closed = false,
    heartbeatDelayMax = 0;
  const stallWindows: EventLoopStallWindow[] = [];
  const send = (message: object): void => {
    if (!closed) worker.postMessage(message);
  };
  const observer: DaemonOperationObserver = {
    begin: (fields) => {
      const registration = operations.begin(fields),
        startedAtMs = fields.startedAtMs ?? Number(process.hrtime.bigint() / 1_000_000n);
      let ended = false;
      return {
        update: registration.update,
        end: (trace?: DaemonOperationTrace) => {
          if (ended) return;
          ended = true;
          registration.end();
          const endedAtMs = trace?.endedAtMs ?? Number(process.hrtime.bigint() / 1_000_000n);
          completions.record({
            method: fields.method,
            nodeId: trace?.nodeId ?? fields.nodeId ?? null,
            endedAtMs,
            durationMs: Math.max(0, endedAtMs - startedAtMs),
            ok: (trace?.outcome ?? fields.outcome) !== "error",
          });
        },
      };
    },
  };
  const heartbeatMs = options.heartbeatMs ?? 250,
    nowMs = (): bigint => process.hrtime.bigint() / 1_000_000n,
    heartbeatDelay = (): number => Math.max(0, Number(nowMs() - Atomics.load(heartbeat, 0)) - heartbeatMs),
    pulse = (): void => {
      const delay = heartbeatDelay(),
        wallAt = Date.now();
      heartbeatDelayMax = Math.max(heartbeatDelayMax, delay);
      if (delay > heartbeatMs) {
        // Stall windows are compared with transport Date.now() observations, so keep wall time here.
        recordEventLoopStallWindow(stallWindows, wallAt - delay, wallAt);
        pruneEventLoopStallWindows(stallWindows, wallAt);
      }
      Atomics.store(heartbeat, 0, nowMs());
    };
  Atomics.store(heartbeat, 0, nowMs());
  histogram.enable();
  const sampleMetrics = (): void => {
    const memory = process.memoryUsage();
    send({
      type: "metrics",
      metrics: {
        sampledAt: new Date().toISOString(),
        ...memory,
        activeHandles: (process as NodeJS.Process & { _getActiveHandles(): readonly unknown[] })._getActiveHandles()
          .length,
        activeResources: process.getActiveResourcesInfo().length,
        ...(options.writeQueues ? { writeQueues: options.writeQueues() } : {}),
        eventLoopDelayMs: {
          mean: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : 0,
          p99: histogram.percentile(99) / 1e6,
          // Histogram timer/reset ordering can miss a native-blocking interval. The existing
          // heartbeat also measures scheduling delay, without adding another timer or probe.
          max: Math.max(histogram.max / 1e6, heartbeatDelayMax, heartbeatDelay()),
          histogramMax: histogram.max / 1e6,
        },
      },
    });
    histogram.reset();
    heartbeatDelayMax = 0;
  };
  sampleMetrics();
  const timer = setInterval(pulse, heartbeatMs),
    metrics = setInterval(() => setImmediate(sampleMetrics), options.metricsIntervalMs ?? 10_000);
  timer.unref();
  metrics.unref();
  const dispose = (): void => {
    closed = true;
    clearInterval(timer);
    clearInterval(metrics);
    histogram.disable();
  };
  // A failed observer is visible, but cannot crash business work or strand its timers.
  worker.on("error", (error) => {
    dispose();
    process.stderr.write(`daemon diagnostics worker failed: ${error.stack ?? error.message}\n`);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", () => {
        worker.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    dispose();
    await worker.terminate();
    throw error;
  }
  worker.unref();
  return {
    observer,
    /** Date a frame observation back only when it was read during a stall recovery turn. */
    frameArrivalAt: (observedAtMs: number): number =>
      frameArrivalAt(observedAtMs, stallWindows, heartbeatMs, heartbeatDelay()),
    state: (state: "starting" | "running" | "draining" | "stopping") => {
      // State must be visible even if the main thread blocks immediately after this call.
      Atomics.store(heartbeat, 1, BigInt(["starting", "running", "draining", "stopping"].indexOf(state)));
    },
    close: async () => {
      if (closed) return;
      dispose();
      worker.ref();
      await new Promise<void>((resolve, reject) => {
        worker.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Diagnostics worker exited ${code}`)),
        );
        worker.postMessage({ type: "close" });
      });
    },
  };
}
