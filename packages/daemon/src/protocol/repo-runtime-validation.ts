import type { JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt } from "./receipt-envelope.ts";
import { isRepoDiagnosticMethod } from "./daemon-log-dispatch.ts";
import type { DaemonRepoNamespace, JsonRpcServerOptions } from "./json-rpc-server.ts";

export function validateRepoRuntime(
  contract: JsonRpcMethodContract,
  repo: DaemonRepoNamespace | undefined,
  options: JsonRpcServerOptions
): ReturnType<typeof failureReceipt> | undefined {
  if (!repo || !contract.requiresRepo || !options.resolveRepoAvailability || isRepoDiagnosticMethod(contract)) return undefined;
  const failure = options.resolveRepoAvailability(repo);
  if (!failure) return undefined;
  return failureReceipt(contract.method, failure.code, repoRuntimeFailureHint(repo, failure), { repo: failure.repo });
}

function repoRuntimeFailureHint(
  repo: DaemonRepoNamespace,
  failure: NonNullable<ReturnType<NonNullable<JsonRpcServerOptions["resolveRepoAvailability"]>>>
): string {
  const statusCommand = `ha --repo ${repo.repoId} daemon status --json`;
  if (failure.code === "repo_lock_held") {
    const lockPath = failure.repo.lockPath ?? "the reported writer lock";
    const owner = failure.repo.lockOwnerToken ?? failure.repo.lastError ?? "owner unknown";
    return `Repo ${repo.repoId} is attached, but its writer lock is held at ${lockPath} (${owner}). Wait for the current writer to release the lock, then run \`${statusCommand}\` before retrying. Do not register, purge, stop, or restart the repo while the lock is held.`;
  }
  const cause = failure.repo.lastError ? `: ${failure.repo.lastError}` : "";
  return `Repo ${repo.repoId} is attached, but its runtime is unavailable${cause}. Run \`${statusCommand}\` to inspect recovery or availability before choosing a repair.`;
}
