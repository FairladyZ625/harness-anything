import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { agentRuntimeModelTier, agentRuntimeTargetForKind } from "./agent-runtime-contract.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";

/**
 * The deterministic instance-selection rule, in one place so dispatch, `ha agent validate`, and
 * the install check cannot drift apart.
 *
 * Rank keys, in order:
 *  1. the declaration's runtimes row that admits the instance (an unbound dispatch shares one
 *     trailing row, which keeps its cross-kind behaviour unchanged);
 *  2. the declaration's `preferredInstances` order, when the instance is listed there;
 *  3. model-match tier: an exact catalog spelling (2) beats a case-insensitive one (1);
 *  4. live session load, dispatch only — see `prepareRuntimeInstance`;
 *  5. repository `runtime.allowedInstances` order, which the resolver already emits.
 *
 * Keys 1-3 are deterministic; key 4 spreads capacity across candidates the first three keys
 * cannot tell apart, and key 5 makes even that tie stable. The receipt always names which key
 * decided, so an operator never has to infer it.
 *
 * Why the model tier exists: providers publish `Deepseek-V4.1-Flash` where a declaration writes
 * `deepseek-v4.1-flash`. Catalog membership used to be the only model check, so two instances of
 * one kind were separated by whether their catalog happened to repeat the declaration's exact
 * spelling — and the same declaration could land on either instance depending on catalog and
 * allowlist order. The tier makes that choice predictable and lets the receipt say which
 * spelling matched.
 */
export type RuntimeInstanceSelectionBasis =
  | "explicit-request"
  | "resumed-session"
  | "declared-instance"
  | "declared-preference"
  | "exact-model"
  | "case-insensitive-model"
  | "runtime-row-order";

export interface RuntimeInstanceSelection {
  readonly instanceId: string;
  readonly basis: RuntimeInstanceSelectionBasis;
  /** One operator-facing sentence: which instance was chosen and why. */
  readonly reason: string;
  /** The catalog spelling to launch. A case-variant match launches the instance's own spelling,
   *  never the declaration's, because the instance store validates model membership verbatim. */
  readonly model: string | null;
}

export interface RuntimeInstanceRank {
  readonly rowIndex: number;
  /** Index in `preferredInstances`; `MAX_SAFE_INTEGER` when the declaration does not list it. */
  readonly preferenceIndex: number;
  /** 2 exact model spelling, 1 case-insensitive spelling, 0 when no model matched. */
  readonly modelTier: 0 | 1 | 2;
}

export interface RuntimeInstanceRankInput {
  readonly agent: RuntimeAgent | null;
  /** The dispatch-level `--model` override; the per-kind declared model applies when this is absent. */
  readonly model?: string;
  readonly instances: readonly RuntimeInstanceSummary[];
}

/** The model one instance must be asked for: the declaration/override when the catalog lists it
 *  verbatim, otherwise the catalog's own spelling of a case-insensitive match. */
export function runtimeInstanceModel(
  instances: readonly RuntimeInstanceSummary[],
  instanceId: string,
  requested: string | undefined,
): string | null {
  const instance = instances.find((row) => row.instanceId === instanceId);
  if (instance === undefined) return requested ?? null;
  if (requested === undefined) return instance.defaultModel;
  if (instance.models.includes(requested)) return requested;
  const folded = requested.toLowerCase();
  return instance.models.find((model) => model.toLowerCase() === folded) ?? null;
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
    rowIndex: rowIndex === -1 ? runtimes.length : rowIndex,
    preferenceIndex: preferenceIndex === -1 ? Number.MAX_SAFE_INTEGER : preferenceIndex,
    modelTier: instance === undefined ? 2 : agentRuntimeModelTier(instance.models, declaredModelFor(input, instance)),
  };
}

/** Lower is better. Equal ranks keep the resolver's configured (allowlist) order. */
export function compareRuntimeInstanceRank(left: RuntimeInstanceRank, right: RuntimeInstanceRank): number {
  return (
    left.rowIndex - right.rowIndex || left.preferenceIndex - right.preferenceIndex || right.modelTier - left.modelTier
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
    tier = instance === undefined ? 2 : agentRuntimeModelTier(instance.models, declaredModel),
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
          agentRuntimeModelTier(other.models, declaredModel) < tier,
      ),
    selection = (basis: RuntimeInstanceSelectionBasis, reason: string): RuntimeInstanceSelection => ({
      instanceId: input.selected,
      basis,
      reason,
      model: launchModel,
    });
  if (input.explicitlyRequested)
    return selection("explicit-request", `The dispatch named instance ${input.selected} explicitly.`);
  if (input.resumedSession)
    return selection("resumed-session", `The resumed provider session runs on instance ${input.selected}.`);
  if (input.agent?.instance === input.selected)
    return selection("declared-instance", `Agent ${input.agent.id} declares instance ${input.selected}.`);
  if (preferenceIndex !== -1)
    return selection(
      "declared-preference",
      `Agent ${input.agent!.id} lists instance ${input.selected} at preferredInstances[${String(preferenceIndex)}]; ` +
        "it is enabled, compatible, and ready on this node.",
    );
  if (declaredModel !== undefined && tier === 2 && modelSeparated)
    return selection(
      "exact-model",
      `Instance ${input.selected} (${kind}) lists the declared model ${declaredModel} verbatim, ` +
        "which ranks ahead of any instance matching it only case-insensitively.",
    );
  if (declaredModel !== undefined && tier === 1)
    return selection(
      "case-insensitive-model",
      `Instance ${input.selected} (${kind}) lists the declared model ${declaredModel} only with different ` +
        `letter case; no enabled instance spelled it verbatim. Pin the instance or the spelling to keep this choice.`,
    );
  // No higher key separated the candidates. Say so instead of attributing the choice to the model
  // tier, which would be a hollow truth whenever every compatible instance spells the model the
  // same way; the remaining keys are live load and then allowed-instance order.
  return selection(
    "runtime-row-order",
    declaredModel === undefined
      ? `Instance ${input.selected} (${kind}) is the first compatible candidate by runtime-row and ` +
          "repository allowed-instance order."
      : `Instance ${input.selected} (${kind}) is the first compatible candidate; runtime row, stated ` +
          `preference, and model spelling did not separate the candidates, so live load then ` +
          "repository allowed-instance order decided.",
  );
}

/** Enabled instances that can serve this declaration's runtimes rows, in instance-id order. */
export function compatibleRuntimeInstances(input: {
  readonly agent: Pick<RuntimeAgent, "runtimes">;
  readonly runtimeInstances: readonly {
    readonly instanceId: string;
    readonly kindId: string;
    readonly models: readonly string[];
    readonly enabled: boolean;
  }[];
}): readonly string[] {
  const runtimes = input.agent.runtimes;
  return input.runtimeInstances
    .filter((instance) => {
      if (!instance.enabled) return false;
      if (runtimes.length > 0 && !runtimes.some((target) => target.type === instance.kindId)) return false;
      const target = runtimes.find((row) => row.type === instance.kindId);
      return agentRuntimeModelTier(instance.models, target?.model) > 0;
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
  readonly agent: Pick<RuntimeAgent, "id" | "runtimes" | "instance" | "preferredInstances">;
  readonly runtimeInstances: readonly {
    readonly instanceId: string;
    readonly kindId: string;
    readonly models: readonly string[];
    readonly enabled: boolean;
  }[];
  readonly selected?: string;
}): { readonly code: string; readonly message: string } | null {
  const agent = input.agent;
  if (agent.instance !== undefined) return null;
  const candidates = compatibleRuntimeInstances(input);
  if (candidates.length < 2) return null;
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
