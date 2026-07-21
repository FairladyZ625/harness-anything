import { publishDaemonRegistryRuntimeProjection } from "@harness-anything/kernel/daemon/registry";
import type { MultiRepoDaemonRuntimeStatus } from "./repo-runtime-options.ts";

export function publishRuntimeRegistrationSnapshot(input: {
  readonly userRoot: string;
  readonly machineId?: string;
  readonly daemonGeneration?: number;
  readonly runtimeStatus: MultiRepoDaemonRuntimeStatus;
}): void {
  if (input.machineId === undefined || input.daemonGeneration === undefined) return;
  const daemonGeneration = input.daemonGeneration;
  publishDaemonRegistryRuntimeProjection({
    userRoot: input.userRoot,
    machineId: input.machineId,
    daemonGeneration,
    registrations: input.runtimeStatus.repos.flatMap((repo) =>
      repo.state === "attached" && repo.runtimeRegistrationId !== undefined
        ? [{
            repoId: repo.repoId,
            runtimeRegistrationId: repo.runtimeRegistrationId,
            daemonGeneration
          }]
        : [])
  });
}
