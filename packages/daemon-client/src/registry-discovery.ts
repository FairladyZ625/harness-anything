// @slice-activation W-D2 fail-closed registry discovery exported for W-D3 host composition.
import { resolveDaemonRepoByRoot } from "@harness-anything/kernel";

export interface RegistryWorkspaceRoute {
  readonly endpoint: string;
  readonly repoId: string;
}

export interface DaemonRegistryResolverOptions {
  readonly endpoint: string;
  readonly userRoot: string;
  readonly resolveRepoByRoot?: typeof resolveDaemonRepoByRoot;
}

export function createDaemonRegistryResolver(options: DaemonRegistryResolverOptions): (rootDir: string) => RegistryWorkspaceRoute | undefined {
  const resolveRepo = options.resolveRepoByRoot ?? resolveDaemonRepoByRoot;
  return (rootDir) => {
    try {
      const repo = resolveRepo(rootDir, { userRoot: options.userRoot });
      return repo?.state === "enabled" ? { endpoint: options.endpoint, repoId: repo.repoId } : undefined;
    } catch {
      return undefined;
    }
  };
}
