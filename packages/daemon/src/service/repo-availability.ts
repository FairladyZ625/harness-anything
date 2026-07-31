import type {
  DaemonRepoAvailabilityFailure,
  DaemonRepoNamespace
} from "../protocol/json-rpc-server.ts";
import type { MultiRepoHarnessDaemonRuntime } from "../runtime/repo-runtime.ts";

export function repoAvailabilityFailure(
  runtime: MultiRepoHarnessDaemonRuntime,
  repo: DaemonRepoNamespace,
  authorityUnavailable?: string
): DaemonRepoAvailabilityFailure | undefined {
  const status = runtime.status().repos.find((candidate) => candidate.repoId === repo.repoId);
  if (!status) {
    return {
      code: "repo_unavailable",
      repo: {
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        state: "unavailable",
        lockPath: null,
        lockOwnerToken: null,
        lastError: "runtime context not found"
      }
    };
  }
  if (status.state === "attached" && !authorityUnavailable) return undefined;
  const lockHeld = typeof status.lastError === "string" && /lock already held|global\.lock/u.test(status.lastError);
  return {
    code: lockHeld ? "repo_lock_held" : "repo_unavailable",
    repo: {
      repoId: repo.repoId,
      canonicalRoot: repo.canonicalRoot,
      state: status.state,
      lockPath: status.lockPath ?? null,
      lockOwnerToken: status.lockOwnerToken ?? null,
      lastError: authorityUnavailable ?? status.lastError ?? null
    }
  };
}
