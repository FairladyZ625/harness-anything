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
  return failureReceipt(contract.method, failure.code, `Repo ${repo.repoId} is not attached to this daemon.`, { repo: failure.repo });
}
