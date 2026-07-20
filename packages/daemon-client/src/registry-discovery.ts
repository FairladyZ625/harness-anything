// @slice-activation W-D2 fail-closed registry discovery exported for W-D3 host composition.
import type { ResolveDaemonRepoByRoot } from "@harness-anything/api-contracts";

export interface RegistryWorkspaceRoute {
  readonly endpoint: string;
  readonly repoId: string;
}

export interface DaemonRegistryResolverOptions {
  readonly endpoint: string;
  readonly userRoot: string;
  readonly resolveRepoByRoot: ResolveDaemonRepoByRoot;
}

export function createDaemonRegistryResolver(options: DaemonRegistryResolverOptions): (rootDir: string) => RegistryWorkspaceRoute | undefined {
  // W1 dependency inversion makes the resolver explicit: restoring the former
  // kernel-backed default would recreate daemon-client -> kernel.
  if (typeof options.resolveRepoByRoot !== "function") {
    throw new TypeError("createDaemonRegistryResolver requires resolveRepoByRoot after PLT-Boundary W1");
  }
  return (rootDir) => {
    try {
      const repo = options.resolveRepoByRoot(rootDir, { userRoot: options.userRoot });
      return repo?.state === "enabled" ? { endpoint: options.endpoint, repoId: repo.repoId } : undefined;
    } catch {
      return undefined;
    }
  };
}
