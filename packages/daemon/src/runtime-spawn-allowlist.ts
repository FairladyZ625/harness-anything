import type { RepositorySettingsV1, TaskProjection } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { locallyObservedRuntimeSessions } from "./runtime-spawn-adoption.ts";
import type { ActiveRuntime, RuntimeSessionSelection, RuntimeSpawnerInput } from "./runtime-spawn-types.ts";

export async function resolveRuntimeDispatchResources(
  input: Pick<RuntimeSpawnerInput, "readSettings" | "runtimeInstances">,
  remote: RuntimeSpawnerInput["remote"],
  projection: TaskProjection,
  processes: ReadonlyMap<string, Pick<ActiveRuntime, "process">>,
): Promise<
  readonly [readonly RuntimeSessionSelection[], readonly RuntimeInstanceSummary[], readonly string[] | undefined]
> {
  const runtimeSessions = remote ? await remote.readRuntimeSessions() : projection.readRuntimeSessions(),
    localRuntimeSessions = locallyObservedRuntimeSessions(runtimeSessions, processes),
    runtimeInstances = input.runtimeInstances?.() ?? [];
  const settings = remote
      ? input.readSettings?.()
      : (projection.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined),
    allowedInstanceIds = settings?.runtime?.allowedInstances;
  return [localRuntimeSessions, runtimeInstances, allowedInstanceIds];
}
