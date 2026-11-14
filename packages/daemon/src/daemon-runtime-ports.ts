import type { openRuntimeInstanceStore } from "./agent-runtime-instances.ts";
import type { DaemonRuntimePorts } from "./daemon-host-context.ts";

type RuntimeInstances = Pick<
  ReturnType<typeof openRuntimeInstanceStore>,
  | "listPublic"
  | "prepareLaunch"
  | "prepareCloudRelay"
  | "reclaimRuntimeTempDirectory"
  | "listRuntimeTempSessionIds"
  | "reclaimSettledRuntimeTempDirectories"
  | "prepareDaemonGitEnvironment"
  | "runtimeProviderHealth"
>;

export function openDaemonRuntimePorts(input: { readonly instances: RuntimeInstances }): DaemonRuntimePorts {
  return {
    runtimeInstances: input.instances.listPublic,
    runtimeProviderHealth: input.instances.runtimeProviderHealth,
    prepareRuntimeLaunch: input.instances.prepareLaunch,
    prepareCloudRelay: input.instances.prepareCloudRelay,
    reclaimRuntimeTempDirectory: input.instances.reclaimRuntimeTempDirectory,
    listRuntimeTempSessionIds: input.instances.listRuntimeTempSessionIds,
    reclaimSettledRuntimeTempDirectories: input.instances.reclaimSettledRuntimeTempDirectories,
    prepareDaemonGitEnvironment: input.instances.prepareDaemonGitEnvironment,
  };
}
