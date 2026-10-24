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
