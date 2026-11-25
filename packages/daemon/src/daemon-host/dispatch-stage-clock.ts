import { AsyncLocalStorage } from "node:async_hooks";

/** The dispatch path stages a launch reports on its `runtime_spawn` lifecycle record. */
export type DispatchStage =
  | "workspace_preflight"
  | "mirror_materialize"
  | "task_context_read"
  | "center_task_start"
  | "replica_wait"
  | "worktree_collision_scan"
  | "origin_refresh"
  | "published_branch_fetch"
  | "worktree_add"
  | "worktree_setup";

interface DispatchStageClock {
  readonly startedAt: number;
  readonly stages: Partial<Record<DispatchStage, number>>;
}

const clocks = new AsyncLocalStorage<DispatchStageClock>();

/**
 * One runtime dispatch crosses the edge runtime, the spawner and the task checkout before its provider launches.
 * Each stage adds its wall-clock duration to the dispatch it runs under, so a slow launch names its slow stage in
 * the daemon lifecycle log instead of only its total. A nested dispatch keeps the outermost clock.
 */
export function withDispatchStageClock<T>(work: () => Promise<T>): Promise<T> {
  return clocks.getStore() ? work() : clocks.run({ startedAt: performance.now(), stages: {} }, work);
}

export async function timeDispatchStage<T>(stage: DispatchStage, work: () => Promise<T> | T): Promise<T> {
  const clock = clocks.getStore();
  if (!clock) return work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    clock.stages[stage] = (clock.stages[stage] ?? 0) + Math.round(performance.now() - startedAt);
  }
}

/** Elapsed time since the dispatch began and the stage durations recorded so far; empty outside a dispatch. */
export function readDispatchStageClock(): {
  readonly durationMs?: number;
  readonly stages?: Readonly<Partial<Record<DispatchStage, number>>>;
} {
  const clock = clocks.getStore();
  return clock ? { durationMs: Math.round(performance.now() - clock.startedAt), stages: { ...clock.stages } } : {};
}
