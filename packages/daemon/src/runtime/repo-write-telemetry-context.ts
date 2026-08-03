import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { RepoWriteTelemetryPhase } from "./repo-write-protocol.ts";

type RepoWriteTelemetryReporter = (
  phase: RepoWriteTelemetryPhase,
  elapsedMs: number
) => void;

export interface RepoWriteTelemetryDelivery {
  readonly report: RepoWriteTelemetryReporter;
  readonly reportCurrent: (phase: RepoWriteTelemetryPhase) => void;
  readonly flush: () => Promise<void>;
  readonly close: () => void;
}

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
  phase: RepoWriteTelemetryPhase
): void {
  const current = storage.getStore();
  if (!current) return;
  current.report(phase, Math.max(0, performance.now() - current.startedAt));
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

export function bindCurrentRepoWriteTelemetry<Result>(
  operation: () => Result
): () => Result {
  const current = storage.getStore();
  return current
    ? () => storage.run(current, operation)
    : operation;
}

export function createRepoWriteTelemetryDelivery(
  deliver: (
    phase: RepoWriteTelemetryPhase,
    elapsedMs: number
  ) => Promise<void>
): RepoWriteTelemetryDelivery {
  let pending = Promise.resolve();
  let closed = false;
  const startedAt = performance.now();
  return {
    report: (phase, elapsedMs) => {
      if (closed) return;
      pending = pending
        .then(() => deliver(phase, elapsedMs))
        .catch(() => undefined);
    },
    reportCurrent: (phase) => {
      if (closed) return;
      pending = pending
        .then(() => deliver(phase, Math.max(0, performance.now() - startedAt)))
        .catch(() => undefined);
    },
    flush: () => pending,
    close: () => {
      closed = true;
    }
  };
}
