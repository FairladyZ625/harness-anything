import { runtimeInstanceDispatchModels } from "@harness-anything/kernel/internal/domain/runtime-instance-contract.ts";
import type {
  RuntimeInstanceDispatchState,
  RuntimeSelectionStrategy,
} from "@harness-anything/kernel/internal/domain/runtime-instance-scheduling.ts";

/** Node-local transient state. Mutations are O(1); load reads visit only currently active attempts. */
export function createRuntimeInstanceDispatchState(): RuntimeInstanceDispatchState {
  const lastDispatchedAt = new Map<string, number>(),
    activeInstances = new Map<string, string>();
  let sequence = 0;
  return {
    lastDispatchedAt,
    recordDispatch: (instanceId) => {
      lastDispatchedAt.set(instanceId, ++sequence);
    },
    activate: (runtimeSessionId, instanceId) => {
      activeInstances.set(runtimeSessionId, instanceId);
    },
    deactivate: (runtimeSessionId) => {
      activeInstances.delete(runtimeSessionId);
    },
    readActiveLoads: () => {
      const loads = new Map<string, number>();
      for (const instanceId of activeInstances.values()) loads.set(instanceId, (loads.get(instanceId) ?? 0) + 1);
      return loads;
    },
  };
}
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import {
  agentRuntimeModelResolution,
  agentRuntimeModelTier,
  agentRuntimeTargetForKind,
} from "./agent-runtime-contract.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";

/** After model/health admission, tier precedes runtime row. Within a tier, sticky retains
 * configured preferences among idle instances; lru uses active load then node-local dispatch
 * recency. Runtime rows and model spelling remain deterministic fallbacks within a tier. */
export type RuntimeInstanceSelectionBasis =
  | "sticky"
  | "lru"
  | "explicit-request"
  | "resumed-session"
  | "declared-instance"
  | "declared-preference"
  | "exact-model"
  | "case-insensitive-model"
  | "runtime-row-order";

export interface RuntimeInstanceSelection {
  readonly instanceId: string;
  readonly tier: number;
  readonly selectionStrategy: RuntimeSelectionStrategy;
  readonly basis: RuntimeInstanceSelectionBasis;
  /** One operator-facing sentence: which instance was chosen and why. */
  readonly reason: string;
  /** The catalog spelling to launch. A case-variant match launches the instance's own spelling,
   *  never the declaration's, because the instance store validates model membership verbatim. */
  readonly model: string | null;
}

export interface RuntimeInstanceRank {
  readonly tier: number;
  readonly rowIndex: number;
  /** Index in `preferredInstances`; `MAX_SAFE_INTEGER` when the declaration does not list it. */
  readonly preferenceIndex: number;
  /** Exact spelling, case-insensitive spelling, or no match (3, 2, 0). */
  readonly modelTier: 0 | 2 | 3;
}

export interface RuntimeInstanceRankInput {
  readonly agent: RuntimeAgent | null;
  /** The dispatch-level `--model` override; the per-kind declared model applies when this is absent. */
  readonly model?: string;
  readonly instances: readonly RuntimeInstanceSummary[];
}

/** The model one instance must be asked for, using the shared declaration-to-catalog resolver. */
export function runtimeInstanceModel(
  instances: readonly RuntimeInstanceSummary[],
  instanceId: string,
  requested: string | undefined,
): string | null {
  const instance = instances.find((row) => row.instanceId === instanceId);
  if (instance === undefined) return requested ?? null;
  return (
    agentRuntimeModelResolution(runtimeInstanceDispatchModels(instance), requested ?? instance.defaultModel)?.model ??
    null
  );
}

function declaredModelFor(input: RuntimeInstanceRankInput, instance: RuntimeInstanceSummary): string | undefined {
  if (input.model !== undefined) return input.model;
  const agent = input.agent;
  if (agent === null || agent.runtimes.length === 0) return undefined;
  return agentRuntimeTargetForKind(agent.runtimes, instance.kindId)?.model;
}

export function runtimeInstanceRank(input: RuntimeInstanceRankInput, instanceId: string): RuntimeInstanceRank {
  const instance = input.instances.find((row) => row.instanceId === instanceId),
    runtimes = input.agent?.runtimes ?? [],
    preferred = input.agent?.preferredInstances ?? [],
    preferenceIndex = preferred.indexOf(instanceId),
    rowIndex = instance === undefined ? runtimes.length : runtimes.findIndex((t) => t.type === instance.kindId);
  return {
    tier: instance?.tier ?? 1,
    rowIndex: rowIndex === -1 ? runtimes.length : rowIndex,
    preferenceIndex: preferenceIndex === -1 ? Number.MAX_SAFE_INTEGER : preferenceIndex,
    modelTier:
      instance === undefined
        ? 3
        : agentRuntimeModelTier(runtimeInstanceDispatchModels(instance), declaredModelFor(input, instance)),
  };
}

/** Lower is better. Equal ranks keep the resolver's configured (allowlist) order. */
export function compareRuntimeInstanceRank(left: RuntimeInstanceRank, right: RuntimeInstanceRank): number {
  return (
    left.tier - right.tier ||
    left.rowIndex - right.rowIndex ||
    left.preferenceIndex - right.preferenceIndex ||
    right.modelTier - left.modelTier
  );
}

/**
 * Which instance the rule selected and the sentence the dispatch receipt repeats. `selected` is
 * the instance `prepareRuntimeInstance` admitted after its own load-aware sort, so a case that
 * reaches key 4 says so instead of pretending a higher key decided.
 */
export function selectedRuntimeInstance(input: {
  readonly agent: RuntimeAgent | null;
  readonly model?: string;
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly selected: string;
  readonly selectionStrategy?: RuntimeSelectionStrategy;
  /** True when the operator named the instance on the command line or dispatch payload. */
  readonly explicitlyRequested?: boolean;
  readonly resumedSession?: boolean;
}): RuntimeInstanceSelection {
  const instance = input.instances.find((row) => row.instanceId === input.selected),
    kind = instance?.kindId ?? "unknown",
    declaredModel = instance === undefined ? input.model : declaredModelFor(input, instance),
    launchModel = runtimeInstanceModel(input.instances, input.selected, declaredModel),
    preferred = input.agent?.preferredInstances ?? [],
    preferenceIndex = preferred.indexOf(input.selected),
    tier = instance === undefined ? 3 : agentRuntimeModelTier(runtimeInstanceDispatchModels(instance), declaredModel),
    // Whether the model tier actually separated this instance from a competing candidate that
    // shares its runtime row. Without this the receipt would credit `exact-model` on a node where
    // every compatible instance spells the model identically — a true but hollow explanation.
    modelSeparated =
      instance !== undefined &&
      declaredModel !== undefined &&
      input.instances.some(
        (other) =>
          other.instanceId !== instance.instanceId &&
          other.enabled &&
          other.kindId === instance.kindId &&
          agentRuntimeModelTier(runtimeInstanceDispatchModels(other), declaredModel) < tier,
      ),
    selection = (basis: RuntimeInstanceSelectionBasis, reason: string): RuntimeInstanceSelection => ({
      instanceId: input.selected,
      basis,
      tier: instance?.tier ?? 1,
      selectionStrategy: input.agent?.selectionStrategy ?? input.selectionStrategy ?? "sticky",
      reason: `${reason} Selected tier ${instance?.tier ?? 1}, strategy ${input.agent?.selectionStrategy ?? input.selectionStrategy ?? "sticky"}.`,
      model: launchModel,
    });
  if (input.explicitlyRequested) {
    const resolutionNote =
      declaredModel !== undefined && launchModel !== null && declaredModel !== launchModel
        ? ` ${input.model !== undefined ? "Requested model" : `Agent ${input.agent?.id ?? "dispatch"} declares model`} ` +
          `${declaredModel}, which resolves to ${launchModel} on instance ${input.selected}.`
        : "";
    return selection("explicit-request", `The dispatch named instance ${input.selected} explicitly.${resolutionNote}`);
  }
  if (input.resumedSession)
    return selection("resumed-session", `The resumed provider session runs on instance ${input.selected}.`);
  if (input.agent?.instance === input.selected)
    return selection("declared-instance", `Agent ${input.agent.id} declares instance ${input.selected}.`);
  const strategy = input.agent?.selectionStrategy ?? input.selectionStrategy;
  if (strategy !== undefined)
    return selection(
      strategy,
      `Instance ${input.selected} (${kind}) was selected from the ready priority tier using ${strategy === "lru" ? "minimum active load, then least-recent dispatch" : "the first idle instance in configured preference order, or a busy candidate when no instance is idle"}.`,
    );
  if (preferenceIndex !== -1)
    return selection(
      "declared-preference",
      `Agent ${input.agent!.id} lists instance ${input.selected} at preferredInstances[${String(preferenceIndex)}]; ` +
        "it is enabled, compatible, and ready on this node.",
    );
  if (declaredModel !== undefined && tier === 3 && modelSeparated)
    return selection(
      "exact-model",
      `Instance ${input.selected} (${kind}) lists the declared model ${declaredModel} verbatim, ` +
        "with configured same-tier preference and availability deciding dispatch.",
    );
  if (declaredModel !== undefined && tier === 2)
    return selection(
      "case-insensitive-model",
      `Instance ${input.selected} (${kind}) lists the declared model ${declaredModel} only with different ` +
        `letter case; the launch uses that catalog spelling.`,
    );
  // No higher key separated the candidates. Say so instead of attributing the choice to the model
  // tier, which would be a hollow truth whenever every compatible instance spells the model the
  // same way; the remaining keys are live load and then allowed-instance order.
  return selection(
    "runtime-row-order",
    declaredModel === undefined
      ? `Instance ${input.selected} (${kind}) is compatible; the configured same-tier strategy selected it.`
      : `Instance ${input.selected} (${kind}) is compatible; runtime row, stated ` +
          `preference, and model spelling did not separate the candidates, so the configured same-tier strategy decided.`,
  );
}

/** Enabled instances that can serve this declaration's runtimes rows, in instance-id order. */
export function compatibleRuntimeInstances(input: {
  readonly agent: Pick<RuntimeAgent, "runtimes">;
  readonly runtimeInstances: readonly {
    readonly instanceId: string;
    readonly kindId: string;
    readonly models: readonly string[];
    readonly availableModels?: readonly string[];
    readonly credentialSource?: "operator" | "instance";
    readonly defaultModel?: string;
    readonly enabled: boolean;
  }[];
}): readonly string[] {
  const runtimes = input.agent.runtimes;
  return input.runtimeInstances
    .filter((instance) => {
      if (!instance.enabled) return false;
      if (runtimes.length > 0 && !runtimes.some((target) => target.type === instance.kindId)) return false;
      const target = runtimes.find((row) => row.type === instance.kindId),
        models = runtimeInstanceDispatchModels(instance);
      return models.length > 0 && agentRuntimeModelTier(models, target?.model ?? instance.defaultModel) > 0;
    })
    .map((instance) => instance.instanceId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The ambiguity `ha agent validate`, `ha agent install`, and dispatch warn about: several enabled
 * instances can serve the declaration and the declaration never says which one to prefer. Dispatch
 * stays deterministic without a preference, but the author's intent is unstated, so the warning
 * names the candidates and both ways to state it. Null when there is no choice left to make: one
 * candidate, a hard `instance` pin, or a `preferredInstances` list that prefers at least every
 * candidate but one.
 *
 * `selected` is set by a dispatch, which has already decided: its sentence reports the instance it
 * took instead of what a future dispatch "would" do, so one definition serves all three surfaces.
 */
export function agentRuntimeAmbiguityWarning(input: {
  readonly agent: Pick<RuntimeAgent, "id" | "runtimes" | "instance" | "preferredInstances" | "selectionStrategy">;
  readonly runtimeInstances: readonly {
    readonly instanceId: string;
    readonly kindId: string;
    readonly models: readonly string[];
    readonly availableModels?: readonly string[];
    readonly credentialSource?: "operator" | "instance";
    readonly defaultModel?: string;
    readonly enabled: boolean;
  }[];
  readonly selected?: string;
  readonly selectionStrategy?: RuntimeSelectionStrategy;
}): { readonly code: string; readonly message: string } | null {
  const agent = input.agent;
  if (agent.instance !== undefined || agent.selectionStrategy !== undefined || input.selectionStrategy !== undefined)
    return null;
  const candidates = compatibleRuntimeInstances(input);
  if (candidates.length < 2) return null;
  // An explicitly enabled same-kind pool states the operator's intent to schedule its members.
  const kinds = new Set(
    input.runtimeInstances.filter((row) => candidates.includes(row.instanceId)).map((row) => row.kindId),
  );
  if (kinds.size === 1) return null;
  const preferred = (agent.preferredInstances ?? []).filter((instanceId) => candidates.includes(instanceId));
  if (preferred.length >= candidates.length - 1) return null;
  return {
    code: "agent_runtime_instance_ambiguous",
    message:
      `Agent ${agent.id} can dispatch to ${String(candidates.length)} enabled instances ` +
      `(${candidates.join(", ")}) and does not name one; ` +
      (input.selected === undefined
        ? "dispatch would fall back to runtime-row then repository allowed-instance order. "
        : `this dispatch took ${input.selected}. `) +
      "Pin one with the `instance` field, or state an order with `preferredInstances`; run ha runtime " +
      "instance list to see the enabled instances.",
  };
}
