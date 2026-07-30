import {
  defaultRepoWriteRequestTimeoutMs,
  type RepoWriteClientLimits
} from "./repo-write-client-contract.ts";

export function resolveRepoWriteClientLimits(
  configured: Partial<RepoWriteClientLimits> | undefined
): RepoWriteClientLimits {
  const requestTimeoutMs = configured?.requestTimeoutMs ?? defaultRepoWriteRequestTimeoutMs;
  const limits = {
    maxPendingRequests: configured?.maxPendingRequests ?? 1_024,
    readyTimeoutMs: configured?.readyTimeoutMs ?? 30_000,
    requestTimeoutMs,
    proceededStallTimeoutMs: configured?.proceededStallTimeoutMs ?? requestTimeoutMs * 2
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (limits.proceededStallTimeoutMs <= limits.requestTimeoutMs) {
    throw new Error("proceededStallTimeoutMs must exceed requestTimeoutMs");
  }
  return limits;
}
