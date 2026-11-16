import type { TaskProjection } from "@harness-anything/kernel";
import {
  executionRuntimeBudgetRefusal,
  executionRuntimeBudgetPolicy,
} from "@harness-anything/kernel/internal/domain/task-submission-policy.ts";
import type { ActiveRuntime } from "./runtime-spawn-types.ts";

/** Terminal reason code for a dispatch stopped by its declared token limit. */
export const runtimeSpendCapReasonCode = "runtime_spend_cap_exceeded";

/** The same consumption total the token usage read model reports: input already includes cache
 * reads/writes, so output is the only addition. */
export function runtimeTokenTotal(active: Pick<ActiveRuntime, "inputTokens" | "outputTokens">): number {
  return active.inputTokens + active.outputTokens;
}

/** One bounded sentence naming the observed and declared counts, used as the attempt reason and
 * the session conclusion text. */
export function runtimeSpendCapReason(
  active: Pick<ActiveRuntime, "tokenLimit" | "inputTokens" | "outputTokens">,
): string {
  return `Dispatch stopped at its token limit: ${runtimeTokenTotal(active)} tokens consumed (limit ${String(active.tokenLimit)}).`;
}

/** Mark the runtime once its provider-reported consumption passes the limit frozen at launch.
 * The flag is one-way: a later session-total replay never un-stops a runtime. */
export function observeRuntimeSpendCap(
  active: Pick<ActiveRuntime, "tokenLimit" | "inputTokens" | "outputTokens" | "spendCapExceeded">,
): void {
  if (active.spendCapExceeded || active.tokenLimit === null) return;
  if (runtimeTokenTotal(active) > active.tokenLimit) active.spendCapExceeded = true;
}

/** Center projection reads only; called again at the dispatch append, never trusted from an edge.
 * The current attempt's terminal metrics may not have been published when fallback is decided. */
export function runtimeExecutionBudgetRefusal(
  projection: TaskProjection,
  task: { readonly taskId: string; readonly executionId: string; readonly role?: string | null },
  tokenLimit: number | null,
  current?: { readonly runtimeSessionId: string; readonly inputTokens: number; readonly outputTokens: number },
) {
  // Review must remain available after implementation exhausts its spending authorization.
  if (task.role === "reviewer") return null;
  const attempts = projection
    .readRuntimeDispatchesByTaskExecution(task.taskId, task.executionId)
    .filter((row) => row.event.payload.role !== "reviewer")
    .map((row) => ({
      runtimeSessionId: row.event.payload.runtimeSessionId,
      totalTokens: row.metrics?.totalTokens ?? 0,
    }));
  if (current) attempts.push({ runtimeSessionId: current.runtimeSessionId, totalTokens: runtimeTokenTotal(current) });
  return executionRuntimeBudgetRefusal(attempts, {
    maxAttempts: executionRuntimeBudgetPolicy.defaultValue.maxAttempts,
    // The declared dispatch usage ceiling also caps the Execution's aggregate consumption.
    maxTokens: tokenLimit !== null && tokenLimit > 0 ? tokenLimit : null,
  });
}
