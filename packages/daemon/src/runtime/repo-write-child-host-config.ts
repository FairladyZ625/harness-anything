import type {
  RepoWriteChildHostLimits,
  RepoWriteChildHostOptions
} from "./repo-write-child-contract.ts";

const defaultLimits: RepoWriteChildHostLimits = {
  maxAdmissions: 64,
  maxRetainedOperations: 16_384,
  maxControlRequests: 16_384,
  shutdownTimeoutMs: 5_000
};

export function validateRepoWriteChildHostIdentity(
  options: RepoWriteChildHostOptions
): void {
  if (!options.repoId.trim()) throw new Error("repoId is required");
  if (!options.workspaceId.trim()) throw new Error("workspaceId is required");
  if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
    throw new Error("generation must be a positive safe integer");
  }
}

export function resolveRepoWriteChildHostLimits(
  overrides: Partial<RepoWriteChildHostLimits> | undefined
): RepoWriteChildHostLimits {
  const limits = {
    maxAdmissions: overrides?.maxAdmissions ?? defaultLimits.maxAdmissions,
    maxRetainedOperations: overrides?.maxRetainedOperations ?? defaultLimits.maxRetainedOperations,
    maxControlRequests: overrides?.maxControlRequests ?? defaultLimits.maxControlRequests,
    shutdownTimeoutMs: overrides?.shutdownTimeoutMs ?? defaultLimits.shutdownTimeoutMs
  };
  assertPositiveLimit(limits.maxAdmissions, "maxAdmissions");
  assertPositiveLimit(limits.maxRetainedOperations, "maxRetainedOperations");
  assertPositiveLimit(limits.maxControlRequests, "maxControlRequests");
  assertPositiveLimit(limits.shutdownTimeoutMs, "shutdownTimeoutMs");
  return limits;
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
