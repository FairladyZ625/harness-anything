import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

const { reconnectBaseDelayMs, reconnectMaxDelayMs, reconnectAttemptLimit } =
  daemonProtocolFleetPolicy.defaultValue.client;

export function clientRetryDelay(attempt: number, random = Math.random()): number | null {
  if (attempt >= reconnectAttemptLimit) return null;
  const ceiling = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** attempt);
  return Math.floor(ceiling * (0.5 + random * 0.5));
}
