// @slice-activation PLT-Boundary W1 owns the daemon registry DTO package API.
export type DaemonRepoState = "enabled" | "disabled";

export interface DaemonRegistryRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly state: DaemonRepoState;
  readonly registeredAt: string;
  readonly authorityManifestPath?: string;
  readonly runtimeRegistrationId?: string;
  readonly daemonGeneration?: number;
}

export interface DaemonRegistryGenerationProjectionV1 {
  readonly machineId?: string;
  readonly daemonGeneration?: number;
}

export interface DaemonRegistryLookupOptions {
  readonly userRoot?: string;
}

export type ResolveDaemonRepoByRoot = (
  rootDir: string,
  options?: DaemonRegistryLookupOptions
) => DaemonRegistryRepo | undefined;
