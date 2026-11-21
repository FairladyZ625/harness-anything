// Pure schema-free runtime constants shared by runtime-engine and protocol validators without Node builtins.
export { agentRuntimeTokenUsageRangeWords } from "@harness-anything/kernel/internal/domain/client-view-status.ts";
export const runtimeMcpPolicies = ["disabled", "inherit"] as const;
export type RuntimeMcpPolicy = (typeof runtimeMcpPolicies)[number];
export function isRuntimeMcpPolicy(value: unknown): value is RuntimeMcpPolicy {
  return typeof value === "string" && (runtimeMcpPolicies as readonly string[]).includes(value);
}
