import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

const { reconnectBaseDelayMs, reconnectMaxDelayMs, reconnectAttemptLimit } =
  daemonProtocolFleetPolicy.defaultValue.client;

export function clientRetryDelay(attempt: number, random = Math.random(), remainingMs?: number): number | null {
  if (remainingMs === undefined ? attempt >= reconnectAttemptLimit : remainingMs <= 0) return null;
  const ceiling = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** attempt);
  return Math.min(remainingMs ?? ceiling, Math.floor(ceiling * (0.5 + random * 0.5)));
}
