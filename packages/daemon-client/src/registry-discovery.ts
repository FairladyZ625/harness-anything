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
  return (rootDir) => {
    try {
      const repo = options.resolveRepoByRoot(rootDir, { userRoot: options.userRoot });
      return repo?.state === "enabled" ? { endpoint: options.endpoint, repoId: repo.repoId } : undefined;
    } catch {
      return undefined;
    }
  };
}
