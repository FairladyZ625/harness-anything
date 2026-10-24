import { FLEET_HELLO_FAILURE_LIMIT, FLEET_HELLO_FAILURE_WINDOW_MS } from "./command-protocol.ts";

/** `source` is the pre-authentication connection source (the peer address). The transport supplies
 * it before any frame is trusted; the claimed node id is not a usable budget key because the
 * unauthenticated hello frame itself chooses it. */
export type HelloAuthenticator = (nodeId: string, credential: string, source: string) => boolean | Promise<boolean>;

/** Failure stamps tracked at once; beyond this the oldest entries are dropped so connections from
 * rotating sources cannot grow the table without bound. */
const trackedSourceLimit = 4096;

/** Fixed-window failure limiter wrapped around the one hello authentication injection. Only
 * failures count: a connection presenting valid credentials always reaches the credential check.
 * Once a source has spent its failure budget the verdict is local and the credential — and any
 * remote introspection behind it — is never consulted again until the window passes.
 *
 * The budget is keyed on the connection source rather than the claimed node id: the id arrives
 * unauthenticated in the hello frame, so keying on it lets one client rotate ids for a fresh budget
 * and lets a stranger spend a real node's budget. */
export function createHelloRateLimiter(
  authenticate: HelloAuthenticator,
  timing: {
    limit?: number;
    windowMs?: number;
    /** Overrides the tracked-source bound (tests); the default bound covers adversarial rotation. */
    trackedSources?: number;
    now?: () => number;
  } = {},
): HelloAuthenticator {
  const limit = timing.limit ?? FLEET_HELLO_FAILURE_LIMIT,
    windowMs = timing.windowMs ?? FLEET_HELLO_FAILURE_WINDOW_MS,
    trackedSources = timing.trackedSources ?? trackedSourceLimit,
    now = timing.now ?? Date.now,
    failures = new Map<string, number[]>();
  return async (nodeId, credential, source) => {
    const stamp = now(),
      recent = (failures.get(source) ?? []).filter((at) => stamp - at < windowMs);
    if (recent.length >= limit) return false;
    if (await authenticate(nodeId, credential, source)) {
      failures.delete(source);
      return true;
    }
    recent.push(stamp);
    failures.set(source, recent);
    if (failures.size > trackedSources) {
      for (const [key, stamps] of failures) {
        if (failures.size <= trackedSources) break;
        if (stamp - stamps[stamps.length - 1]! >= windowMs) failures.delete(key);
      }
      for (const key of failures.keys()) {
        if (failures.size <= trackedSources) break;
        failures.delete(key);
      }
    }
    return false;
  };
}
