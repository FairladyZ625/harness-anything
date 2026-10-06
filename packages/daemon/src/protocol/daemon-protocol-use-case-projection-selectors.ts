import { useCaseProjectionFacetWords, useCaseProjectionNameWords } from "./daemon-protocol-vocabulary.ts";

/**
 * Use-case projection transport contract (dec_5B135F46 CH4 layer two).
 *
 * The kernel catalog says which named projections exist and which views consume them; this is the
 * wire half, and — the part that matters — the *single* boundary where a selector is admitted. The
 * precedent (`task_e75157a2d1538a71726603aeef`) shipped facet selectors whose vocabulary ended up
 * restated in five files, so adding a facet to only some of them failed asymmetrically instead of
 * fail-closed. `admitUseCaseProjectionSelector` is called by the RPC request validator, the
 * repo-cell handler and the GUI preload, so all three reject identically.
 *
 * This lives on the thin-CLI/daemon transport path, so it carries no runtime kernel import; the
 * name mirror in `daemon-protocol-vocabulary.ts` is pinned to the kernel type at compile time.
 */
export const useCaseProjectionSchemaId = "daemon.use-case-projection/v1" as const;

export type UseCaseProjectionName = (typeof useCaseProjectionNameWords)[number];

export const useCaseProjectionFacets = Object.freeze({
  "schedule-plane": Object.freeze(["plane"] as const),
  "schedule-run-history": Object.freeze(["runs"] as const),
  "runtime-session-groups": Object.freeze(["groups"] as const),
});

export type UseCaseProjectionFacet = (typeof useCaseProjectionFacetWords)[number];

/**
 * The closed field set a projection may carry, `name` and `facet` included. Anything else on the
 * payload is rejected at the boundary rather than silently ignored by one layer and honoured by
 * the next.
 */
function useCaseProjectionSelectorFields(name: UseCaseProjectionName): readonly string[] {
  const base = ["name", "facet"];
  if (name === "schedule-plane") return base;
  if (name === "schedule-run-history") return [...base, "scheduleId", "limit"];
  return [...base, "groupBy", "since", "query", "agentId", "squadId", "status", "sessionIds", "limit"];
}

export function isUseCaseProjectionName(value: unknown): value is UseCaseProjectionName {
  return typeof value === "string" && (useCaseProjectionNameWords as readonly string[]).includes(value);
}

export function isUseCaseProjectionFacet(name: UseCaseProjectionName, facet: unknown): facet is UseCaseProjectionFacet {
  return typeof facet === "string" && (useCaseProjectionFacets[name] as readonly string[]).includes(facet);
}

/**
 * The one admission routine. Returns the resolved `{name, facet}` or the reason it is inadmissible,
 * so every layer that guards this read rejects for the same reason with the same words.
 */
export function admitUseCaseProjectionSelector(
  payload: Readonly<Record<string, unknown>>,
): { readonly name: UseCaseProjectionName; readonly facet: UseCaseProjectionFacet } | string {
  const { name } = payload;
  if (!isUseCaseProjectionName(name)) return `Use-case projection name is unknown: ${String(name)}.`;
  const facet = payload.facet === undefined ? useCaseProjectionFacets[name][0] : payload.facet;
  if (!isUseCaseProjectionFacet(name, facet))
    return (
      `Use-case projection ${name} has no facet ${String(facet)}; ` +
      `expected ${useCaseProjectionFacets[name].join(", ")}.`
    );
  const allowed = useCaseProjectionSelectorFields(name);
  const unexpected = Object.keys(payload).filter((field) => !allowed.includes(field));
  if (unexpected.length > 0)
    return (
      `Use-case projection ${name}/${facet} does not accept ${unexpected.sort().join(", ")}; ` +
      `expected only ${allowed.join(", ")}.`
    );
  return { name, facet };
}
