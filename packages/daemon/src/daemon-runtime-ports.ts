import { openRuntimeProviderHealthStore } from "./runtime-provider-health.ts";
import type { openRuntimeInstanceStore } from "./agent-runtime-instances.ts";
import type { DaemonRuntimePorts } from "./daemon-host-context.ts";

type RuntimeInstances = Pick<
  ReturnType<typeof openRuntimeInstanceStore>,
  | "listPublic"
  | "prepareLaunch"
  | "prepareCloudRelay"
  | "reclaimRuntimeTempDirectory"
  | "reclaimSettledRuntimeTempDirectories"
  | "prepareDaemonGitEnvironment"
>;

export function openDaemonRuntimePorts(input: {
  readonly userRoot: string;
  readonly instances: RuntimeInstances;
}): DaemonRuntimePorts {
  return {
    runtimeInstances: input.instances.listPublic,
    runtimeProviderHealth: openRuntimeProviderHealthStore(input.userRoot),
    prepareRuntimeLaunch: input.instances.prepareLaunch,
    prepareCloudRelay: input.instances.prepareCloudRelay,
    reclaimRuntimeTempDirectory: input.instances.reclaimRuntimeTempDirectory,
    reclaimSettledRuntimeTempDirectories: input.instances.reclaimSettledRuntimeTempDirectories,
    prepareDaemonGitEnvironment: input.instances.prepareDaemonGitEnvironment,
  };
}
