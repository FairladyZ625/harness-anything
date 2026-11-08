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
    (instanceId: string) => number,
  ]
> {
  // Dispatch selection reads the unsettled set plus the one native session a resume names
  // (usually settled). Settled history beyond that is never read. Instance load is the canonical
  // lifecycle reservation count, never a local process map or PID probe.
  const read = (query: RuntimeSessionReadQuery) =>
      remote ? remote.readRuntimeSessions(query) : projection!.readRuntimeSessions(query),
    byId = new Map<string, RuntimeSessionSelection>();
  for (const session of [
    ...(await read({ unsettledOnly: true })),
    ...(providerSessionId === undefined ? [] : await read({ providerSessionId })),
  ])
    byId.set(session.runtimeSessionId, session);
  const runtimeSessions = [...byId.values()].sort((a, b) => (a.runtimeSessionId < b.runtimeSessionId ? -1 : 1)),
    runtimeInstances = input.runtimeInstances?.() ?? [];
  const settings = remote
      ? input.readSettings?.()
      : (projection!.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined),
    allowedInstanceIds = settings?.runtime?.allowedInstances,
    health = input.runtimeProviderHealth?.list() ?? [];
  return [
    runtimeSessions,
    runtimeInstances,
    allowedInstanceIds,
    health,
    lifecycleInstanceLoad(remote ? null : projection),
  ];
}

/** Count an instance's unreleased reservations through the one lifecycle read port, page by page. */
function lifecycleInstanceLoad(projection: TaskProjection | null): (instanceId: string) => number {
  return (instanceId) => {
    if (!projection?.readDispatchLifecycle) return 0;
    let load = 0,
      afterGroupId: string | undefined;
    do {
      const page = projection.readDispatchLifecycle({
        by: "active",
        instanceId,
        limit: 100,
        ...(afterGroupId ? { afterGroupId } : {}),
      });
      if (page.status !== "ready") return load;
      load += page.rows.filter((row) => row.attempt.capacity !== "released").length;
      afterGroupId = page.nextCursor ?? undefined;
    } while (afterGroupId);
    return load;
  };
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
