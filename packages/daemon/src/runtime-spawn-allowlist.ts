import type { TaskProjection } from "@harness-anything/kernel";
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
    runtimeInstances = input.runtimeInstances?.() ?? [],
    enabledInstanceIds = [
      ...new Set(runtimeInstances.filter((instance) => instance.enabled).map((instance) => instance.instanceId)),
    ];
  if (!dryRun) await input.initializeAllowedInstances?.(binding, runtimeInstances);
  const persistedAllowedInstanceIds = input.readSettings?.().runtime?.allowedInstances,
    // A caller without the repository-writer initializer (remote edges and lightweight
    // spawner fixtures) cannot persist the first snapshot, but an unset repository still
    // follows the machine's enabled instances for this dispatch. An authored empty array
    // remains the explicit deny-all value.
    allowedInstanceIds = persistedAllowedInstanceIds ?? (enabledInstanceIds.length ? enabledInstanceIds : undefined);
  return [localRuntimeSessions, runtimeInstances, allowedInstanceIds];
}
