import { FLEET_HELLO_FAILURE_LIMIT, FLEET_HELLO_FAILURE_WINDOW_MS } from "./command-protocol.ts";

export type HelloAuthenticator = (nodeId: string, credential: string) => boolean | Promise<boolean>;

/** Failure stamps tracked at once; beyond this the oldest entries are dropped so an attacker
 * rotating unregistered node ids cannot grow the table without bound. */
const trackedNodeLimit = 4096;

/** Fixed-window failure limiter wrapped around the one hello authentication injection. Only
 * failures count: a node presenting valid credentials always reaches the credential check. Once
 * a node has spent its failure budget the verdict is local and the credential — and any remote
 * introspection behind it — is never consulted again until the window passes. */
export function createHelloRateLimiter(
  authenticate: HelloAuthenticator,
  timing: {
    limit?: number;
    windowMs?: number;
    /** Overrides the tracked-node bound (tests); the default bound covers adversarial id rotation. */
    trackedNodes?: number;
    now?: () => number;
  } = {},
): HelloAuthenticator {
  const limit = timing.limit ?? FLEET_HELLO_FAILURE_LIMIT,
    windowMs = timing.windowMs ?? FLEET_HELLO_FAILURE_WINDOW_MS,
    trackedNodes = timing.trackedNodes ?? trackedNodeLimit,
    now = timing.now ?? Date.now,
    failures = new Map<string, number[]>();
  return async (nodeId, credential) => {
    const stamp = now(),
      recent = (failures.get(nodeId) ?? []).filter((at) => stamp - at < windowMs);
    if (recent.length >= limit) return false;
    if (await authenticate(nodeId, credential)) {
      failures.delete(nodeId);
      return true;
    }
    recent.push(stamp);
    failures.set(nodeId, recent);
    if (failures.size > trackedNodes) {
      for (const [key, stamps] of failures) {
        if (failures.size <= trackedNodes) break;
        if (stamp - stamps[stamps.length - 1]! >= windowMs) failures.delete(key);
      }
      for (const key of failures.keys()) {
        if (failures.size <= trackedNodes) break;
        failures.delete(key);
      }
    }
    return false;
  };
}
