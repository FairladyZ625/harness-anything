import type { ActorAxes } from "../schemas/actor-attribution.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { localLayoutFileSystem } from "../local/local-layout-file-system.ts";
import type { EntityAttributionProjection } from "./types.ts";

export const unresolvedEntityAttribution = (): EntityAttributionProjection => ({
  originator: null,
  latestActor: null,
  trailCount: 0,
  completeness: "unresolved"
});

export function legacyEntityAttribution(
  originator: ActorAxes | null,
  latestActor: ActorAxes | null = originator
): EntityAttributionProjection {
  if (!originator) return unresolvedEntityAttribution();
  return {
    originator,
    latestActor,
    trailCount: 0,
    completeness: "legacy-partial"
  };
}

export function readLegacyPersonIds(rootInput: HarnessLayoutInput): ReadonlySet<string> {
  const peoplePath = `${resolveHarnessLayout(rootInput).authoredRoot}/people.yaml`;
  if (!localLayoutFileSystem.exists(peoplePath)) return new Set();
  const body = localLayoutFileSystem.readText(peoplePath);
  const ids = [...body.matchAll(/(?:^|\n)\s*(?:-\s*)?personId:\s*["']?([^\s"'#]+)["']?/gu)].map((match) => match[1]!);
  try {
    const json = JSON.parse(body) as { readonly people?: ReadonlyArray<{ readonly personId?: unknown }> };
    for (const person of json.people ?? []) if (typeof person.personId === "string") ids.push(person.personId);
  } catch {
    // The canonical roster is YAML; JSON is accepted as a strict YAML subset for fixtures.
  }
  return new Set(ids);
}
