import type { TaskLifecycleSnapshot } from "@harness-anything/kernel";
import type { CloseoutAssessment } from "@harness-anything/kernel/internal/domain/closeout-readiness";
import type { TaskDeliveryStage } from "./protocol/daemon-protocol-gui-types.ts";

/**
 * 「完成」只收最近 24h 内终态的任务:业主 2026-10-23 裁定累计完成数对「今天做成了什么」
 * 没有意义。窗口判在这里而不在渲染层,同一时刻所有读者看到同一个桶。
 */
export const TASK_DELIVERY_DONE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The daemon owns this judgment so the live floor's pipeline view is one truth for every
 * renderer. Inputs are the assessments `repo.tasks.list` already derives per row (kernel
 * closeout and blocking judgments plus the lifecycle snapshot); nothing is re-derived here.
 *
 * Priority answers "what is this task waiting for right now":
 * awaiting_owner (an unanswered owner ask, or the one consent only the owner can give)
 * beats rework (rejected, awaiting the owner's re-dispatch), which beats the lifecycle
 * positions. Off-path positions still get their pipeline word — planned queues, a
 * depends-on block waits upstream, a fresh terminal is done for 24h — so the renderer never
 * re-judges a window or a position from status words. `null` means genuinely off the
 * pipeline: cancelled, terminal older than the window, or an unrecognized status.
 */
export function taskDeliveryStage(input: {
  readonly status: string;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly closeout: Pick<CloseoutAssessment, "readiness" | "blocker">;
  readonly blocking: { readonly blockers: ReadonlyArray<{ readonly kind: "awaits" | "depends-on" }> };
  /** Row update instant; the terminal window is judged against it. */
  readonly updatedAt: string;
  readonly nowMs?: number;
}): TaskDeliveryStage | null {
  const { status, snapshot, closeout, blocking } = input;
  if (status === "planned") return "queued";
  if (status === "done") {
    const updatedAt = Date.parse(input.updatedAt),
      nowMs = input.nowMs ?? Date.now();
    return Number.isFinite(updatedAt) && nowMs - updatedAt <= TASK_DELIVERY_DONE_WINDOW_MS ? "done" : null;
  }
  if (status !== "active" && status !== "submitted" && status !== "in_review" && status !== "blocked") return null;
  if (closeout.blocker === "consent" || blocking.blockers.some(({ kind }) => kind === "awaits"))
    return "awaiting_owner";
  // 评审打回、球已回到使用者手里:与 agenda awaitingRework 同一判据(active、无在飞
  // execution、最新 execution 以 changes_requested 关闭)。
  if (
    status === "active" &&
    snapshot.lease === null &&
    !snapshot.executions.some(({ state }) => state === "active") &&
    latestExecutionState(snapshot.executions) === "changes_requested"
  )
    return "rework";
  // depends-on 阻塞是等上游,不在交付主路径上。
  if (status === "blocked") return "waiting_upstream";
  if (closeout.readiness === "ready") return "merge_ready";
  if (status === "in_review") return "reviewing";
  if (status === "submitted") return "delivered";
  return "implementing";
}

/** 最新一轮 execution 的终态(同 iteration 后到者胜出);无 execution 为 undefined。 */
function latestExecutionState(
  executions: ReadonlyArray<{ readonly state: string; readonly iteration: number }>,
): string | undefined {
  let latest: { readonly state: string; readonly iteration: number } | undefined;
  for (const execution of executions)
    if (latest === undefined || execution.iteration >= latest.iteration) latest = execution;
  return latest?.state;
}
