import type { RepositorySettingsV1, RuntimeSessionReadQuery, TaskProjection } from "@harness-anything/kernel";
import { agentRuntimeModelMatches } from "./agent-runtime-contract.ts";
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
    readonly import("../runtime-engine/runtime-provider-health.ts").RuntimeProviderHealth[],
  ]
> {
  // Repository lifecycle rows cannot describe node-local load: they include remote owners and
  // exclude this node's other repositories. Admission reads its own lifecycle at the write boundary.
  const read = (query: RuntimeSessionReadQuery) =>
      remote ? remote.readRuntimeSessions(query) : projection!.readRuntimeSessions(query),
    localRuntimeSessions = providerSessionId === undefined ? [] : await read({ providerSessionId }),
    settings = input.readSettings?.(),
    runtime =
      settings?.runtime ??
      (projection?.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined)?.runtime,
    allowedKinds = runtime?.allowedKinds,
    allowedModels = runtime?.allowedModels,
    instances = input.runtimeInstances?.() ?? [],
    runtimeInstances =
      allowedModels === undefined
        ? instances
        : instances.map((instance) => ({
            ...instance,
            models: instance.models.filter((model) => agentRuntimeModelMatches(allowedModels, model)),
          })),
    capabilityAllowedInstanceIds =
      allowedKinds === undefined && allowedModels === undefined
        ? undefined
        : runtimeInstances
            .filter(
              (instance) =>
                (allowedKinds === undefined || allowedKinds.includes(instance.kindId)) &&
                (allowedModels === undefined || instance.models.length > 0),
            )
            .map((instance) => instance.instanceId),
    localOrder = settings?.runtime?.allowedInstances,
    allowedInstanceIds =
      capabilityAllowedInstanceIds === undefined
        ? localOrder
        : (localOrder ?? capabilityAllowedInstanceIds).filter((id) => capabilityAllowedInstanceIds.includes(id)),
    health = input.runtimeProviderHealth?.list() ?? [];
  return [localRuntimeSessions, runtimeInstances, allowedInstanceIds, health];
}
