import { Worker } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DaemonOperationObserver, DaemonOperationUpdate } from "./daemon-operation.ts";

export interface DaemonDiagnosticsOptions {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly endpoint: string;
  readonly heartbeatMs?: number;
  readonly stallThresholdMs?: number;
  readonly metricsIntervalMs?: number;
}
export async function openDaemonDiagnostics(options: DaemonDiagnosticsOptions) {
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(16)),
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
      },
    });
  let nextId = 0,
    closed = false;
  const send = (message: object): void => {
    if (!closed) worker.postMessage(message);
  };
  const observer: DaemonOperationObserver = {
    begin: (fields) => {
      const id = String(++nextId);
      send({
        type: "begin",
        operation: {
          id,
          method: fields.method.slice(0, 256),
          repoId: fields.repoId?.slice(0, 256) ?? null,
          actor: fields.actor?.slice(0, 256) ?? null,
          phase: fields.phase?.slice(0, 256) ?? "started",
          startedAt: new Date().toISOString(),
        },
      });
      return {
        update: (update: DaemonOperationUpdate) =>
          send({
            type: "update",
            id,
            fields: {
              ...(update.phase === undefined ? {} : { phase: update.phase.slice(0, 256) }),
              ...(update.repoId === undefined ? {} : { repoId: update.repoId?.slice(0, 256) ?? null }),
              ...(update.actor === undefined ? {} : { actor: update.actor?.slice(0, 256) ?? null }),
            },
          }),
        end: () => send({ type: "end", id }),
      };
    },
  };
  const pulse = (): void => {
    Atomics.store(heartbeat, 0, process.hrtime.bigint() / 1_000_000n);
  };
  pulse();
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
        eventLoopDelayMs: {
          mean: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : 0,
          p99: histogram.percentile(99) / 1e6,
          max: histogram.max / 1e6,
        },
      },
    });
    histogram.reset();
  };
  sampleMetrics();
  const timer = setInterval(pulse, options.heartbeatMs ?? 250),
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
