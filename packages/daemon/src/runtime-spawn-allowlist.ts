import type { RepositorySettingsV1, TaskProjection } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { locallyObservedRuntimeSessions } from "./runtime-spawn-adoption.ts";
import type {
  ActiveRuntime,
  RuntimeBinding,
  RuntimeSessionSelection,
  RuntimeSpawnerInput,
} from "./runtime-spawn-types.ts";

export async function resolveRuntimeDispatchResources(
  input: Pick<RuntimeSpawnerInput, "initializeAllowedInstances" | "readSettings" | "runtimeInstances">,
  remote: RuntimeSpawnerInput["remote"],
  projection: TaskProjection,
  processes: ReadonlyMap<string, Pick<ActiveRuntime, "process">>,
  dryRun: boolean,
  binding: RuntimeBinding,
): Promise<
  readonly [readonly RuntimeSessionSelection[], readonly RuntimeInstanceSummary[], readonly string[] | undefined]
> {
  const runtimeSessions = remote ? await remote.readRuntimeSessions() : projection.readRuntimeSessions(),
    localRuntimeSessions = locallyObservedRuntimeSessions(runtimeSessions, processes),
    runtimeInstances = input.runtimeInstances?.() ?? [];
  if (!dryRun) await input.initializeAllowedInstances?.(binding, runtimeInstances);
  const settings = remote
      ? input.readSettings?.()
      : (projection.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined),
    allowedInstanceIds = settings?.runtime?.allowedInstances;
  return [localRuntimeSessions, runtimeInstances, allowedInstanceIds];
}
