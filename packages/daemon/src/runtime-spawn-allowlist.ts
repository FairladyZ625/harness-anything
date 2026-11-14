import type { RepositorySettingsV1, RuntimeSessionReadQuery, TaskProjection } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { RuntimeSessionSelection, RuntimeSpawnerInput } from "./runtime-spawn-types.ts";

export async function resolveRuntimeDispatchResources(
  input: Pick<RuntimeSpawnerInput, "readSettings" | "runtimeInstances" | "runtimeProviderHealth">,
  remote: RuntimeSpawnerInput["remote"],
  projection: TaskProjection | null,
  providerSessionId?: string,
): Promise<
  readonly [
    readonly RuntimeSessionSelection[],
    readonly RuntimeInstanceSummary[],
    readonly string[] | undefined,
    readonly import("./runtime-provider-health.ts").RuntimeProviderHealth[],
  ]
> {
  // Repository lifecycle rows cannot describe node-local load: they include remote owners and
  // exclude this node's other repositories. Admission reads its own lifecycle at the write boundary.
  const read = (query: RuntimeSessionReadQuery) =>
      remote ? remote.readRuntimeSessions(query) : projection!.readRuntimeSessions(query),
    localRuntimeSessions = providerSessionId === undefined ? [] : await read({ providerSessionId }),
    runtimeInstances = input.runtimeInstances?.() ?? [];
  const settings = remote
      ? input.readSettings?.()
      : (projection!.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined),
    allowedInstanceIds = settings?.runtime?.allowedInstances,
    health = input.runtimeProviderHealth?.list() ?? [];
  return [localRuntimeSessions, runtimeInstances, allowedInstanceIds, health];
}

/** ha init captures machine availability during the operator's repository setup. */
export function initialRuntimeInstanceSettings<Settings extends RepositorySettingsV1>(
  settings: Settings,
  instances: readonly Pick<RuntimeInstanceSummary, "instanceId" | "enabled">[],
): Settings {
  return settings.runtime?.allowedInstances === undefined
    ? {
        ...settings,
        runtime: {
          ...settings.runtime,
          allowedInstances: [...new Set(instances.filter((row) => row.enabled).map((row) => row.instanceId))],
        },
      }
    : settings;
}
