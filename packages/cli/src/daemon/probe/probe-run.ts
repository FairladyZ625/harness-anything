import type { CapturePort, CaptureResult } from "./probe-capture.ts";
import type { ProcessMetrics } from "./probe-metrics.ts";
import { createTriggerTracker, type ProbeState, type TriggerReason } from "./probe-trigger.ts";
import { openProbeRpc } from "./probe-rpc.ts";
import type { TimelineWriter } from "./probe-timeline.ts";

export interface ProbePing {
  readonly state: ProbeState;
  readonly latencyMs: number;
  readonly helloMs: number;
  readonly statusMs: number | null;
  readonly helloOk: boolean;
  readonly statusOk: boolean;
  readonly error: string | null;
  readonly errorCode: string | null;
}

export interface ProbeSample extends ProbePing {
  readonly at: number;
  readonly pid: number | null;
  readonly cpuPercent: number | null;
  readonly rssBytes: number | null;
  readonly threadCount: number | null;
  readonly openFileCount: number | null;
  readonly metricsSource: string;
  readonly metricsUnavailable: readonly string[];
  readonly metricsError: string | null;
}

export interface ProbeLoopDeps {
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly slowMs: number;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly readPid: () => number | null;
  readonly readMetrics: (pid: number | null) => Promise<ProcessMetrics>;
  readonly writer: TimelineWriter;
  readonly capture: CapturePort;
  readonly jsStackMethod: string;
  readonly sampleSeconds: number;
  readonly shouldStop: () => boolean;
  readonly onSample?: (sample: ProbeSample) => void;
}

export interface ProbeLoopOptions {
  readonly intervalMs: number;
  readonly iterations: number | null;
  readonly durationMs: number | null;
  readonly unresponsiveMs: number;
  readonly cpuPercent: number;
  readonly cpuSustainMs: number;
  readonly rssBytes: number;
  readonly cooldownMs: number;
  readonly captureDir: string;
}

export interface ProbeRunResult {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly samples: number;
  readonly up: number;
  readonly slow: number;
  readonly down: number;
  readonly captures: number;
  readonly captureFiles: readonly string[];
  readonly errors: readonly string[];
}

export async function pingDaemon(socketPath: string, timeoutMs: number, slowMs: number): Promise<ProbePing> {
  const started = Date.now();
  let helloOk = false,
    statusOk = false,
    helloMs = 0,
    statusMs: number | null = null,
    failure: unknown = null;
  const opened = await openProbeRpc(socketPath, timeoutMs).then(
    (rpc) => ({ ok: true as const, rpc }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!opened.ok) failure = opened.error;
  else {
    helloOk = true;
    helloMs = Date.now() - started;
    const statusStarted = Date.now(),
      answered = await opened.rpc.client.request("daemon.status", {}, timeoutMs).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    statusMs = Date.now() - statusStarted;
    if (answered.ok) {
      statusOk = answered.result.ok !== false;
      if (!statusOk)
        failure = Object.assign(new Error(String(answered.result.code ?? "status rejected")), answered.result);
    } else failure = answered.error;
    opened.rpc.client.close();
  }
  const latencyMs = Date.now() - started,
    state: ProbeState =
      !helloOk || !statusOk ? "down" : Math.max(latencyMs, helloMs, statusMs ?? 0) >= slowMs ? "slow" : "up";
  return {
    state,
    latencyMs,
    helloMs,
    statusMs,
    helloOk,
    statusOk,
    error: failure === null ? null : errorMessage(failure),
    errorCode: failure === null ? null : errorCode(failure),
  };
}

export async function takeProbeSample(
  deps: Pick<ProbeLoopDeps, "socketPath" | "timeoutMs" | "slowMs" | "now" | "readPid" | "readMetrics">,
): Promise<ProbeSample> {
  const at = deps.now(),
    ping = await pingDaemon(deps.socketPath, deps.timeoutMs, deps.slowMs);
  let pid: number | null = null,
    metrics: ProcessMetrics | null = null,
    metricsError: string | null = null;
  const pidRead = attemptSync(() => deps.readPid());
  if (pidRead.ok) pid = pidRead.value;
  else {
    const detail = `pid: ${pidRead.error}`;
    metricsError = detail;
  }
  const metricsRead = await deps.readMetrics(pid).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: errorMessage(error) }),
  );
  if (metricsRead.ok) metrics = metricsRead.value;
  else {
    const detail = [metricsError, `metrics: ${metricsRead.error}`].filter(Boolean).join("; ");
    metricsError = detail;
  }
  return {
    ...ping,
    at,
    pid,
    cpuPercent: metrics?.cpuPercent ?? null,
    rssBytes: metrics?.rssBytes ?? null,
    threadCount: metrics?.threadCount ?? null,
    openFileCount: metrics?.openFileCount ?? null,
    metricsSource: metrics?.source ?? "unavailable",
    metricsUnavailable: metrics?.unavailable ?? ["all"],
    metricsError: [metricsError, metrics?.error].filter(Boolean).join("; ") || null,
  };
}

export async function runProbeLoop(deps: ProbeLoopDeps, options: ProbeLoopOptions): Promise<ProbeRunResult> {
  const startedAt = deps.now(),
    tracker = createTriggerTracker({
      unresponsiveMs: options.unresponsiveMs,
      cpuPercent: options.cpuPercent,
      cpuSustainMs: options.cpuSustainMs,
      rssBytes: options.rssBytes,
      cooldownMs: options.cooldownMs,
    }),
    counts = { up: 0, slow: 0, down: 0 },
    captureFiles: string[] = [],
    errors: string[] = [];
  let samples = 0,
    captures = 0;
  await appendSafely(deps.writer, errors, {
    kind: "probe_start",
    at: new Date(startedAt).toISOString(),
    options: {
      intervalMs: options.intervalMs,
      unresponsiveMs: options.unresponsiveMs,
      cpuPercent: options.cpuPercent,
      cpuSustainMs: options.cpuSustainMs,
      rssBytes: options.rssBytes,
      cooldownMs: options.cooldownMs,
      captureDir: options.captureDir,
    },
  });
  let nextAt = startedAt;
  while (!deps.shouldStop()) {
    if (options.iterations !== null && samples >= options.iterations) break;
    if (options.durationMs !== null && deps.now() - startedAt >= options.durationMs) break;
    const sample = await takeProbeSample(deps);
    samples += 1;
    counts[sample.state] += 1;
    deps.onSample?.(sample);
    await appendSafely(deps.writer, errors, sampleRecord(sample));
    const reason = tracker.evaluate(sample);
    if (reason !== null) {
      const captured = await runCapture(deps, sample, reason, options, errors);
      captures += 1;
      captureFiles.push(...captured.files);
      await appendSafely(deps.writer, errors, {
        kind: "capture",
        at: new Date(deps.now()).toISOString(),
        reason,
        pid: sample.pid,
        files: captured.files,
        errors: captured.errors,
        jsStack: captured.jsStack,
      });
    }
    nextAt = Math.max(nextAt + options.intervalMs, deps.now() + 250);
    if (deps.shouldStop()) break;
    if (options.iterations !== null && samples >= options.iterations) break;
    if (options.durationMs !== null && deps.now() - startedAt >= options.durationMs) break;
    await deps.wait(nextAt - deps.now());
  }
  const endedAt = deps.now();
  await appendSafely(deps.writer, errors, {
    kind: "probe_stop",
    at: new Date(endedAt).toISOString(),
    samples,
    captures,
    errors,
  });
  return {
    startedAt,
    endedAt,
    samples,
    up: counts.up,
    slow: counts.slow,
    down: counts.down,
    captures,
    captureFiles,
    errors,
  };
}

async function runCapture(
  deps: ProbeLoopDeps,
  sample: ProbeSample,
  reason: TriggerReason,
  options: ProbeLoopOptions,
  errors: string[],
): Promise<CaptureResult> {
  if (sample.pid === null) {
    errors.push(`capture skipped (${reason}): daemon pid is unknown`);
    return {
      files: [],
      errors: [`capture skipped: daemon pid is unknown`],
      jsStack: { method: deps.jsStackMethod, status: "unreachable", file: null, detail: "daemon pid is unknown" },
    };
  }
  try {
    return await deps.capture.capture({
      pid: sample.pid,
      reason,
      at: deps.now(),
      dir: options.captureDir,
      socketPath: deps.socketPath,
      jsStackMethod: deps.jsStackMethod,
      jsStackTimeoutMs: Math.max(1_000, deps.timeoutMs),
      sampleSeconds: deps.sampleSeconds,
    });
  } catch (error) {
    const failure = errorMessage(error);
    errors.push(`capture failed (${reason}): ${failure}`);
    return {
      files: [],
      errors: [`capture failed: ${failure}`],
      jsStack: { method: deps.jsStackMethod, status: "failed", file: null, detail: failure },
    };
  }
}

function sampleRecord(sample: ProbeSample): Readonly<Record<string, unknown>> {
  return {
    kind: "sample",
    at: new Date(sample.at).toISOString(),
    state: sample.state,
    latencyMs: sample.latencyMs,
    helloMs: sample.helloMs,
    statusMs: sample.statusMs,
    helloOk: sample.helloOk,
    statusOk: sample.statusOk,
    error: sample.error,
    errorCode: sample.errorCode,
    pid: sample.pid,
    cpuPercent: sample.cpuPercent,
    rssBytes: sample.rssBytes,
    threadCount: sample.threadCount,
    openFileCount: sample.openFileCount,
    metricsSource: sample.metricsSource,
    metricsUnavailable: sample.metricsUnavailable,
    metricsError: sample.metricsError,
  };
}

async function appendSafely(
  writer: TimelineWriter,
  errors: string[],
  record: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  return writer.append(record).then(
    () => true,
    (error: unknown) => {
      errors.push(`timeline: ${errorMessage(error)}`);
      return false;
    },
  );
}

function attemptSync<T>(
  read: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
