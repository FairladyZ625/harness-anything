import type { TaskDispatchRow } from "./protocol/task-dispatch-contract.ts";

/** A live dispatch with no observation for this long is surfaced as suspected stalled. */
export const DISPATCH_STALLED_AFTER_MS = 10 * 60_000;

export type DispatchActivityStatus = "progressing" | "waiting_ci" | "stalled" | "unknown";

/**
 * The daemon owns this judgment so every renderer sees the same activity state. A submitted
 * implementation is waiting on the PR/CI/review path; a reviewer remains active work. Stuck
 * needs a real signal, not a default: the worker process being gone while the run is still
 * marked running is a broken chain and reads stalled immediately; otherwise the signal is the
 * last observation instant (valid UTC encodings can differ in precision). `processAlive` is
 * null when the dispatch stream carries no process record — that signal is absent, not false,
 * and only the time window judges then.
 */
export function dispatchActivityStatus(
  input: {
    readonly status: TaskDispatchRow["status"];
    readonly taskStatus: string | undefined;
    readonly role: string | undefined;
    readonly lastObservedAt: string;
    readonly processAlive: boolean | null;
  },
  nowMs = Date.now(),
): DispatchActivityStatus {
  if (input.status !== "running") return "unknown";
  if (input.taskStatus === "submitted" && input.role !== "reviewer") return "waiting_ci";
  if (input.processAlive === false) return "stalled";
  const observedAt = Date.parse(input.lastObservedAt);
  return Number.isFinite(observedAt) && nowMs - observedAt >= DISPATCH_STALLED_AFTER_MS ? "stalled" : "progressing";
}
