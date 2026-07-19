export type DaemonRepoState = "enabled" | "disabled";

export interface DaemonRegistryRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly state: DaemonRepoState;
  readonly registeredAt: string;
  readonly authorityManifestPath?: string;
}

export interface DaemonRegistryLookupOptions {
  readonly userRoot?: string;
}

export type ResolveDaemonRepoByRoot = (
  rootDir: string,
  options?: DaemonRegistryLookupOptions
) => DaemonRegistryRepo | undefined;
