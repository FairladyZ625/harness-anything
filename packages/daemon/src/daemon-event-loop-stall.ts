// A frame is observed by the event loop only after the loop can run. A stall that ended just
// before the frame was read therefore hides the time the frame spent waiting. Keep the observed
// stall as a bounded time window: only frames read in the recovery turn claim it, and a later
// frame on an idle connection never inherits a historical stall.
export interface EventLoopStallWindow {
  readonly fromMs: number;
  readonly toMs: number;
}
const MAX_WINDOWS = 32;
const MAX_AGE_MS = 60_000;

export function recordEventLoopStallWindow(windows: EventLoopStallWindow[], fromMs: number, toMs: number): void {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
  windows.push({ fromMs, toMs });
  if (windows.length > MAX_WINDOWS) windows.shift();
}

/**
 * Date a frame observation back to the start of a stall only when the frame was read in the
 * recovery turn. `currentDelayMs` covers the race where the frame is handled before the heartbeat
 * pulse records its window; it may only date a currently-running stall, never a past one.
 */
export function frameArrivalAt(
  observedAtMs: number,
  windows: readonly EventLoopStallWindow[],
  heartbeatMs: number,
  currentDelayMs = 0,
): number {
  const graceMs = Math.max(1, heartbeatMs) * 2;
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index]!;
    if (observedAtMs < window.toMs) continue;
    if (observedAtMs - window.toMs > graceMs) break;
    return Math.max(0, window.fromMs);
  }
  if (currentDelayMs > Math.max(1, heartbeatMs)) return Math.max(0, observedAtMs - currentDelayMs);
  return observedAtMs;
}

export function pruneEventLoopStallWindows(windows: EventLoopStallWindow[], nowMs: number): void {
  while (windows.length > 0 && nowMs - windows[0]!.toMs > MAX_AGE_MS) windows.shift();
}
