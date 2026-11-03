// Diagnostic polling is the volume driver at fleet scale: every node sends hello/status while
// business writes remain comparatively rare. Trace those polls in full at normal rates; above
// 2,000 requests/second keep one in twenty. Business methods are always traced, so the slow and
// failing requests that need stage attribution are never sampled out.
const DIAGNOSTIC_METHODS = new Set(["protocol.hello", "daemon.status"]);
const WINDOW_MS = 1_000;
const FULL_RATE = 2_000;
const SAMPLE_EVERY = 50;

let windowStartedAt = 0;
let windowCount = 0;

export function shouldTraceRequest(method: string, nowMs = Date.now()): boolean {
  if (nowMs - windowStartedAt >= WINDOW_MS) {
    windowStartedAt = nowMs;
    windowCount = 0;
  }
  windowCount += 1;
  if (windowCount <= FULL_RATE) return true;
  if (!DIAGNOSTIC_METHODS.has(method)) return true;
  return windowCount % SAMPLE_EVERY === 0;
}

/** Test hook: reset the rate window without exposing the counter. */
export function resetRequestTraceSampling(): void {
  windowStartedAt = 0;
  windowCount = 0;
}
