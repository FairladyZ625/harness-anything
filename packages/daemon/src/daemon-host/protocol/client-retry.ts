import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

const { reconnectBaseDelayMs, reconnectMaxDelayMs, reconnectAttemptLimit } =
  daemonProtocolFleetPolicy.defaultValue.client;

export function clientRetryDelay(attempt: number, random = Math.random(), handoffUntil?: number): number | null {
  const ceiling = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** attempt);
  const delay = Math.floor(ceiling * (0.5 + random * 0.5));
  if (handoffUntil === undefined) return attempt < reconnectAttemptLimit ? delay : null;
  const now = performance.now();
  return now < handoffUntil ? Math.min(delay, Math.ceil(handoffUntil - now)) : null;
}
