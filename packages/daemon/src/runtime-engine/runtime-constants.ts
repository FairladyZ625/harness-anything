// Pure schema-free runtime constants shared by runtime-engine and protocol validators without Node builtins.
export const runtimeMcpPolicies = ["disabled", "inherit"] as const;
export type RuntimeMcpPolicy = (typeof runtimeMcpPolicies)[number];
export function isRuntimeMcpPolicy(value: unknown): value is RuntimeMcpPolicy {
  return typeof value === "string" && (runtimeMcpPolicies as readonly string[]).includes(value);
}

export const agentRuntimeTokenUsageRangeWords = Object.freeze(["today", "7d", "30d"]);
