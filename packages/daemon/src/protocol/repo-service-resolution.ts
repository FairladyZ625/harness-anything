import type {
  DaemonRepoNamespace,
  DaemonServiceHost,
  JsonRpcServerOptions
} from "./json-rpc-server.ts";

export function resolveServicesForRepo(
  method: string,
  repo: DaemonRepoNamespace,
  options: JsonRpcServerOptions
): DaemonServiceHost | undefined {
  if (!options.resolveRepoServices) return options.services;
  return options.resolveRepoServices(repo)
    ?? (method === "repo.daemon.status" || method === "repo.daemon.logs.list" ? options.services : undefined);
}
