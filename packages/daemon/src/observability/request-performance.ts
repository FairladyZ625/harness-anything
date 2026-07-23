import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export const daemonRequestPerformancePhases = [
  "received",
  "transport-queue",
  "handler",
  "identity",
  "service",
  "command-parse",
  "command-normalize",
  "command-execute",
  "queue-wait",
  "durable-flush",
  "authority",
  "git",
  "fsync",
  "projection",
  "materializer",
  "response"
] as const;

export type DaemonRequestPerformancePhase = (typeof daemonRequestPerformancePhases)[number];
export type DaemonRequestPerformanceOutcome =
  | "response-written"
  | "handler-error"
  | "response-write-error"
  | "connection-closed";

export interface DaemonRequestPerformanceSummary {
  readonly schema: "daemon-request-performance/v1";
  readonly method: string;
  readonly requestId: string;
  readonly outcome: DaemonRequestPerformanceOutcome;
  readonly totalMs: number;
  readonly eventLoopActiveMs: number;
  readonly eventLoopUtilization: number;
  readonly phaseOrder: ReadonlyArray<DaemonRequestPerformancePhase>;
  readonly phasesMs: Readonly<Record<DaemonRequestPerformancePhase, number | null>>;
}

export type DaemonRequestPerformanceTerminalSink = (
  summary: DaemonRequestPerformanceSummary
) => void | Promise<void>;

export interface DaemonRequestPerformanceTrace {
  readonly begin: (phase: DaemonRequestPerformancePhase) => () => void;
  readonly record: (phase: DaemonRequestPerformancePhase, milliseconds: number) => void;
  readonly setTerminalSink: (sink: DaemonRequestPerformanceTerminalSink) => void;
  readonly finish: (
    outcome: DaemonRequestPerformanceOutcome,
    eventLoopActiveMs?: number,
    eventLoopUtilization?: number
  ) => DaemonRequestPerformanceSummary;
}

export interface DaemonRequestPerformanceTraceOptions {
  readonly method: string;
  readonly requestId: string | number;
  readonly receivedAtMs: number;
  readonly now?: () => number;
}

const storage = new AsyncLocalStorage<DaemonRequestPerformanceTrace>();
const messageLimitBytes = 4_096;

export function createDaemonRequestPerformanceTrace(
  options: DaemonRequestPerformanceTraceOptions
): DaemonRequestPerformanceTrace {
  const now = options.now ?? (() => performance.now());
  const phaseOrder: DaemonRequestPerformancePhase[] = [];
  const phases = new Map<DaemonRequestPerformancePhase, number>();
  const phaseDepths = new Map<DaemonRequestPerformancePhase, number>();
  const receivedAtMs = finiteNonNegative(options.receivedAtMs);
  let sink: DaemonRequestPerformanceTerminalSink | undefined;
  let terminal: DaemonRequestPerformanceSummary | undefined;

  const enterPhase = (phase: DaemonRequestPerformancePhase): void => {
    if (terminal || phases.has(phase)) return;
    phaseOrder.push(phase);
    phases.set(phase, 0);
  };
  const record = (phase: DaemonRequestPerformancePhase, milliseconds: number): void => {
    if (terminal) return;
    enterPhase(phase);
    phases.set(phase, (phases.get(phase) ?? 0) + finiteNonNegative(milliseconds));
  };
  record("received", 0);

  return {
    begin: (phase) => {
      enterPhase(phase);
      const depth = phaseDepths.get(phase) ?? 0;
      phaseDepths.set(phase, depth + 1);
      const startedAt = now();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        phaseDepths.set(phase, Math.max(0, (phaseDepths.get(phase) ?? 1) - 1));
        if (depth === 0) record(phase, now() - startedAt);
      };
    },
    record,
    setTerminalSink: (nextSink) => {
      if (!terminal) sink = nextSink;
    },
    finish: (outcome, eventLoopActiveMs = 0, eventLoopUtilization = 0) => {
      if (terminal) return terminal;
      const phasesMs = Object.fromEntries(
        daemonRequestPerformancePhases.map((phase) => [
          phase,
          phases.has(phase) ? roundMilliseconds(phases.get(phase)!) : null
        ])
      ) as unknown as Record<DaemonRequestPerformancePhase, number | null>;
      terminal = Object.freeze({
        schema: "daemon-request-performance/v1",
        method: safeMethod(options.method),
        requestId: safeRequestId(options.requestId),
        outcome,
        totalMs: roundMilliseconds(now() - receivedAtMs),
        eventLoopActiveMs: roundMilliseconds(eventLoopActiveMs),
        eventLoopUtilization: roundRatio(eventLoopUtilization),
        phaseOrder: Object.freeze([...phaseOrder]),
        phasesMs: Object.freeze(phasesMs)
      });
      if (sink) {
        try {
          void Promise.resolve(sink(terminal)).catch(() => undefined);
        } catch {
          // Performance telemetry must never change the request outcome.
        }
      }
      return terminal;
    }
  };
}

export function runWithDaemonRequestPerformanceTrace<Result>(
  trace: DaemonRequestPerformanceTrace | undefined,
  operation: () => Result
): Result {
  return trace ? storage.run(trace, operation) : storage.exit(operation);
}

export function currentDaemonRequestPerformanceTrace(): DaemonRequestPerformanceTrace | undefined {
  return storage.getStore();
}

export function measureCurrentDaemonRequestPerformancePhase<Result>(
  phase: DaemonRequestPerformancePhase,
  operation: () => Result
): Result {
  const trace = currentDaemonRequestPerformanceTrace();
  if (!trace) return operation();
  const end = trace.begin(phase);
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          end();
          return value;
        },
        (error: unknown) => {
          end();
          throw error;
        }
      ) as Result;
    }
    end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}

export function setCurrentDaemonRequestPerformanceTerminalSink(
  sink: DaemonRequestPerformanceTerminalSink
): void {
  currentDaemonRequestPerformanceTrace()?.setTerminalSink(sink);
}

export function serializeDaemonRequestPerformanceSummary(
  summary: DaemonRequestPerformanceSummary
): string {
  const message = JSON.stringify(summary);
  if (Buffer.byteLength(message, "utf8") > messageLimitBytes) {
    throw new Error("daemon request performance summary exceeds the daemon log message limit");
  }
  return message;
}

function isPromiseLike<Result>(value: Result): value is Result & PromiseLike<Awaited<Result>> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

function safeMethod(value: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(value) ? value : "unknown";
}

function safeRequestId(value: string | number): string {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(finiteNonNegative(value) * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(Math.min(1, finiteNonNegative(value)) * 10_000) / 10_000;
}
