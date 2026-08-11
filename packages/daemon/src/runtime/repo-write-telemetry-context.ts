import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type {
  RepoWriteTelemetryDetails,
  RepoWriteTelemetryPhase,
  RepoWriteTelemetrySpan
} from "./repo-write-protocol.ts";

type RepoWriteTelemetryReporter = (
  phase: RepoWriteTelemetryPhase,
  elapsedMs: number,
  details?: RepoWriteTelemetryDetails
) => void;

export interface RepoWriteTelemetryDelivery {
  readonly report: RepoWriteTelemetryReporter;
  readonly reportCurrent: (phase: RepoWriteTelemetryPhase, details?: RepoWriteTelemetryDetails) => void;
  readonly flush: () => Promise<void>;
  readonly stream: () => Promise<void>;
  readonly close: () => void;
}

export interface RepoWriteTelemetryDeliveryOptions {
  readonly deliverBatch: (spans: ReadonlyArray<RepoWriteTelemetrySpan>) => Promise<void>;
  readonly deliverStream: (
    phase: RepoWriteTelemetryPhase,
    elapsedMs: number,
    details?: RepoWriteTelemetryDetails
  ) => Promise<void>;
  readonly streamAfterMs?: number;
}

export const defaultRepoWriteTelemetryStreamAfterMs = 20_000;

const storage = new AsyncLocalStorage<{
  readonly startedAt: number;
  readonly report: RepoWriteTelemetryReporter;
}>();

export function runWithRepoWriteTelemetry<Result>(
  report: RepoWriteTelemetryReporter,
  operation: () => Result
): Result {
  return storage.run({ startedAt: performance.now(), report }, operation);
}

export function reportCurrentRepoWriteTelemetry(
  phase: RepoWriteTelemetryPhase,
  details?: RepoWriteTelemetryDetails
): void {
  const current = storage.getStore();
  if (!current) return;
  current.report(phase, Math.max(0, performance.now() - current.startedAt), details);
}

export async function executeRepoWriteChildWithTelemetry<Result>(
  delivery: RepoWriteTelemetryDelivery,
  execute: () => Result | Promise<Result>
): Promise<Result> {
  return runWithRepoWriteTelemetry(delivery.report, async () => {
    reportCurrentRepoWriteTelemetry("journal");
    const outcome = await execute();
    reportCurrentRepoWriteTelemetry("child-execution-returned");
    return outcome;
  });
}

export function bindCurrentRepoWriteTelemetry<Arguments extends ReadonlyArray<unknown>, Result>(
  operation: (...args: Arguments) => Result
): (...args: Arguments) => Result {
  const current = storage.getStore();
  return current
    ? (...args) => storage.run(current, () => operation(...args))
    : operation;
}

export function createRepoWriteTelemetryDelivery(
  options: RepoWriteTelemetryDeliveryOptions
): RepoWriteTelemetryDelivery {
  let pending = Promise.resolve();
  let closed = false;
  let streaming = false;
  const buffered: RepoWriteTelemetrySpan[] = [];
  const startedAt = performance.now();
  const streamAfterMs = options.streamAfterMs ?? defaultRepoWriteTelemetryStreamAfterMs;
  if (!Number.isSafeInteger(streamAfterMs) || streamAfterMs <= 0) {
    throw new Error("streamAfterMs must be a positive safe integer");
  }
  const enqueue = (operation: () => Promise<void>): void => {
    pending = pending.then(operation).catch(() => undefined);
  };
  const flushBuffered = (): void => {
    if (buffered.length === 0) return;
    const spans = buffered.splice(0, buffered.length);
    enqueue(() => options.deliverBatch(spans));
  };
  const enterStreaming = (): void => {
    if (closed || streaming) return;
    streaming = true;
    flushBuffered();
  };
  const streamTimer = setTimeout(enterStreaming, streamAfterMs);
  streamTimer.unref?.();
  const report: RepoWriteTelemetryReporter = (phase, elapsedMs, details) => {
    if (closed) return;
    if (!streaming && performance.now() - startedAt >= streamAfterMs) {
      enterStreaming();
    }
    const span: RepoWriteTelemetrySpan = {
      phase,
      elapsedMs,
      ...(details ? { details } : {})
    };
    if (streaming) {
      enqueue(() => options.deliverStream(phase, elapsedMs, details));
      return;
    }
    buffered.push(span);
  };
  return {
    report,
    reportCurrent: (phase, details) => {
      report(phase, Math.max(0, performance.now() - startedAt), details);
    },
    flush: () => {
      flushBuffered();
      return pending;
    },
    stream: () => {
      enterStreaming();
      return pending;
    },
    close: () => {
      clearTimeout(streamTimer);
      closed = true;
    }
  };
}
