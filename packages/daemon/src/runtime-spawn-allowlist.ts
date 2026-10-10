import type { TaskProjection } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { locallyObservedRuntimeSessions } from "./runtime-spawn-adoption.ts";
import type {
  RuntimeAllowlistInitializationReceipt,
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
  readonly [
    readonly RuntimeSessionSelection[],
    readonly RuntimeInstanceSummary[],
    RuntimeAllowlistInitializationReceipt | null,
    readonly string[],
  ]
> {
  const runtimeSessions = remote ? await remote.readRuntimeSessions() : projection.readRuntimeSessions(),
    localRuntimeSessions = locallyObservedRuntimeSessions(runtimeSessions, processes),
    runtimeInstances = input.runtimeInstances?.() ?? [],
    initialization = dryRun ? null : await input.initializeAllowedInstances?.(binding, runtimeInstances),
    allowedInstanceIds = input.readSettings?.().runtime?.allowedInstances ?? [];
  return [localRuntimeSessions, runtimeInstances, initialization ?? null, allowedInstanceIds];
}
