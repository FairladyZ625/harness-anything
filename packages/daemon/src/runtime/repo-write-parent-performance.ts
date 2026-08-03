import {
  currentDaemonRequestPerformanceTrace,
  type DaemonRequestPerformanceTrace
} from "../observability/request-performance.ts";

export interface RepoWriteParentPerformanceTiming {
  readonly trace: DaemonRequestPerformanceTrace;
  readonly endDispatch: () => void;
  endChild?: () => void;
  childStarted: boolean;
  settled: boolean;
}

export function beginRepoWriteParentPerformanceTiming(): RepoWriteParentPerformanceTiming | undefined {
  const trace = currentDaemonRequestPerformanceTrace();
  return trace ? {
    trace,
    endDispatch: trace.begin("repo-write-dispatch"),
    childStarted: false,
    settled: false
  } : undefined;
}

export function markRepoWriteChildStarted(
  timing: RepoWriteParentPerformanceTiming | undefined
): void {
  if (!timing || timing.settled || timing.childStarted) return;
  timing.childStarted = true;
  timing.endDispatch();
  timing.endChild = timing.trace.begin("repo-write-child");
}

export function finishRepoWriteParentPerformanceTiming(
  timing: RepoWriteParentPerformanceTiming | undefined
): void {
  if (!timing || timing.settled) return;
  timing.settled = true;
  timing.endDispatch();
  timing.endChild?.();
}
