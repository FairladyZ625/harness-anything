import { randomUUID } from "node:crypto";
import type { RuntimeProviderUnreachable } from "@harness-anything/kernel";
import { providerConnectionFailure } from "./dispatch-activity.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { ActiveRuntime, ProviderReconnect } from "./runtime-spawn-types.ts";
import { scrubSecretText } from "./secret-scrub.ts";

/**
 * The executing node owns the provider-connectivity judgment: the network exit is local. These
 * two transitions report it through the existing runtime event channel so the center can serve
 * the same classification without probing anything itself. Publishing happens only when the
 * state changes (or the provider's error text changes), never per frame and never on a timer.
 */
export async function noteProviderProgress(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  observedAtMs: number,
): Promise<void> {
  const previousProgress = Number.isFinite(active.lastRealProgressAtMs) ? active.lastRealProgressAtMs : 0;
  if (!Number.isFinite(observedAtMs) || observedAtMs < previousProgress) return;
  active.lastRealProgressAtMs = Math.max(previousProgress, observedAtMs);
  const evidence = active.providerUnreachable ?? null;
  if (evidence === null || observedAtMs <= Date.parse(evidence.lastProgressAt)) return;
  active.providerUnreachable = null;
  await publishProviderState(context, active, null);
}

/** A reconnect is the provider failing to carry the turn, not progress. Once the real-progress
 * clock is older than the frozen threshold, the same `providerConnectionFailure` judgment used by
 * the read surface turns the frame into the one reported classification. It never cancels,
 * re-dispatches, or waits on a new timer: the provider's own retry frames keep arriving. */
export async function noteProviderReconnect(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  reconnect: ProviderReconnect,
  observedAtMs: number,
): Promise<void> {
  if (active.stalledAt != null || context.exiting?.has?.(active.runtimeSessionId) === true) return;
  const lastRealProgressAt = Number.isFinite(active.lastRealProgressAtMs) ? active.lastRealProgressAtMs : observedAtMs,
    evidence = providerConnectionFailure(
      {
        lastProgressAt: new Date(lastRealProgressAt).toISOString(),
        providerReconnect: {
          occurredAt: new Date(observedAtMs).toISOString(),
          diagnostic: scrubSecretText(reconnect.diagnostic),
        },
        processAlive: true,
        stallTimeoutMs: active.stallTimeoutMs,
      },
      observedAtMs,
    );
  if (evidence === null) return;
  const current = active.providerUnreachable ?? null;
  if (current !== null) {
    const textChanged = current.lastError !== evidence.lastError;
    active.providerUnreachable = evidence;
    if (!textChanged) return;
    await publishProviderState(context, active, evidence);
    return;
  }
  active.providerUnreachable = evidence;
  await publishProviderState(context, active, evidence);
}

async function publishProviderState(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  providerUnreachable: RuntimeProviderUnreachable | null,
): Promise<void> {
  await context.publishRuntimeEvent(
    "runtime_session_liveness_changed",
    { runtimeSessionId: active.runtimeSessionId, liveness: "live", providerUnreachable },
    randomUUID(),
    active.binding,
  );
}
