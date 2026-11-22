import { key, presetFailure } from "./preset-resolver-common.ts";
import type { Candidate, PresetFailure, Provider } from "./preset-resolver-types.ts";
import type { CapabilityRefV1, PresetProfileV3, PresetTaskManifestV3 } from "./preset.contract.ts";

/** Capability imports carry an optional `required` flag; only resolution reads it. */
export type CapabilityImport = CapabilityRefV1 & { readonly required?: boolean };

export type PresetAncestry =
  | { readonly ok: true; readonly ancestry: readonly Candidate[] }
  | { readonly ok: false; readonly error: PresetFailure };

/** The throwing form used by resolution: a broken chain aborts that one preset. */
export function requireAncestry(
  catalog: ReadonlyMap<string, Candidate>,
  selected: Candidate,
  verticalId: string,
): readonly Candidate[] {
  const result = presetAncestry(catalog, selected, verticalId);
  if (!result.ok) throw result.error;
  return result.ancestry;
}

/**
 * Walks `extends` from the selected package up to its root, in resolution order. A broken chain is
 * returned as the failure `resolve()` reports, so a caller that lists a whole catalog can downgrade
 * that one entry instead of failing every list.
 */
export function presetAncestry(
  catalog: ReadonlyMap<string, Candidate>,
  selected: Candidate,
  verticalId: string,
): PresetAncestry {
  const ancestry: Candidate[] = [],
    seen = new Set<string>();
  let current: Candidate | undefined = selected;
  while (current) {
    if (seen.has(current.id))
      return {
        ok: false,
        error: presetFailure("extends_cycle", `Preset extends cycle includes ${current.id}.`),
      };
    seen.add(current.id);
    ancestry.unshift(current);
    const parentId = current.decoded!.manifest.extends;
    if (!parentId) return { ok: true, ancestry };
    const parent = catalog.get(key(verticalId, parentId));
    if (!parent?.decoded)
      return {
        ok: false,
        error: presetFailure("missing_parent", `Preset parent ${parentId} is missing or invalid.`),
      };
    current = parent;
  }
  return { ok: true, ancestry };
}

/** The presets of one vertical whose manifest declares a profile id, in id order. */
export function presetsDeclaringProfile(
  catalog: ReadonlyMap<string, Candidate>,
  verticalId: string,
  profileId: string,
): string[] {
  const prefix = key(verticalId, "");
  return [...catalog]
    .filter(
      ([catalogKey, item]) =>
        catalogKey.startsWith(prefix) && item.decoded?.manifest.profiles.some(({ id }) => id === profileId),
    )
    .map(([, item]) => item.id)
    .sort();
}

/** Whether a candidate's effective availability requires `taskClass="work"` and has all providers satisfied. */
export function candidateAvailability(
  catalog: ReadonlyMap<string, Candidate>,
  verticalId: string,
  candidate: Candidate,
  providers: ReadonlyMap<string, Provider>,
): PresetAvailability | null {
  if (!candidate.decoded) return null;
  const ancestry = presetAncestry(catalog, candidate, verticalId);
  if (!ancestry.ok) return null;
  const availability = presetAvailability({
    catalog,
    verticalId,
    ancestry: ancestry.ancestry,
    providers,
  });
  return availability.missingProviderIds.length === 0 ? availability : null;
}

/** Valid non-work presets of one vertical whose manifest declares `outputShape`, in id order. */
export function presetsWithOutputShape(
  catalog: ReadonlyMap<string, Candidate>,
  verticalId: string,
  outputShape: string,
  providers: ReadonlyMap<string, Provider>,
): string[] {
  const prefix = key(verticalId, "");
  return [...catalog]
    .filter(([catalogKey, item]) => {
      if (!catalogKey.startsWith(prefix) || item.decoded?.manifest.outputShape !== outputShape) return false;
      const availability = candidateAvailability(catalog, verticalId, item, providers);
      return availability !== null && availability.requiredTaskClass !== "work";
    })
    .map(([, item]) => item.id)
    .sort((left, right) => left.localeCompare(right));
}

/** Valid presets of one vertical whose resolved capabilities require `taskClass="work"`, in id order. */
export function workPresetIdsForVertical(
  catalog: ReadonlyMap<string, Candidate>,
  verticalId: string,
  providers: ReadonlyMap<string, Provider>,
): string[] {
  const prefix = key(verticalId, "");
  return [...catalog]
    .filter(([catalogKey, item]) => {
      if (!catalogKey.startsWith(prefix) || !item.decoded) return false;
      const availability = candidateAvailability(catalog, verticalId, item, providers);
      return availability?.requiredTaskClass === "work";
    })
    .map(([, item]) => item.id)
    .sort((left, right) => left.localeCompare(right));
}

/** Valid non-work presets of one vertical selectable as a repository default, in id order. */
export function defaultPresetCandidatesForVertical(
  catalog: ReadonlyMap<string, Candidate>,
  verticalId: string,
  providers: ReadonlyMap<string, Provider>,
): Candidate[] {
  const prefix = key(verticalId, "");
  return [...catalog]
    .filter(([catalogKey, item]) => {
      if (!catalogKey.startsWith(prefix) || !item.decoded) return false;
      const availability = candidateAvailability(catalog, verticalId, item, providers);
      return availability !== null && availability.requiredTaskClass !== "work";
    })
    .map(([, item]) => item)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function profileFor(
  manifest: PresetTaskManifestV3,
  requested?: string,
  declaredElsewhere: readonly string[] = [],
): PresetProfileV3 {
  const id = requested ?? manifest.defaultProfile,
    profile = manifest.profiles.find((item) => item.id === id);
  if (!profile)
    throw presetFailure(
      "missing_profile",
      `Profile ${id} is unavailable on preset ${manifest.id}; its profiles: ` +
        `${manifest.profiles.map((item) => item.id).join(", ")}.` +
        (declaredElsewhere.length ? ` Presets that declare ${id}: ${declaredElsewhere.join(", ")}.` : ""),
    );
  return profile;
}

/**
 * Everything resolution gates a preset on: one profile per ancestry layer (the leaf honours
 * `requestedProfile`, ancestors use their declared `defaultProfile`) and the capability imports
 * merged from every layer. `ha preset list` and `resolve()` both read this one projection, so the
 * hint cannot advertise a preset the resolver would reject for a missing provider.
 */
export interface PresetAvailability {
  readonly profiles: readonly PresetProfileV3[];
  readonly imports: readonly CapabilityImport[];
  readonly missingProviderIds: readonly string[];
  readonly requiredTaskClass?: "work";
}

export function presetAvailability(input: {
  readonly catalog: ReadonlyMap<string, Candidate>;
  readonly verticalId: string;
  readonly ancestry: readonly Candidate[];
  readonly providers: ReadonlyMap<string, Provider>;
  readonly requestedProfile?: string;
}): PresetAvailability {
  const { catalog, verticalId, ancestry, providers, requestedProfile } = input,
    manifests = ancestry.map((item) => item.decoded!.manifest),
    declaredElsewhere = requestedProfile ? presetsDeclaringProfile(catalog, verticalId, requestedProfile) : [],
    profiles = manifests.map((manifest, index) =>
      index === manifests.length - 1 ? profileFor(manifest, requestedProfile, declaredElsewhere) : profileFor(manifest),
    ),
    imports = manifests.flatMap((manifest, index) => [
      ...manifest.capabilityImports,
      ...(profiles[index]!.capabilityImports ?? []),
    ]);
  let requiredTaskClass: "work" | undefined;
  const missingProviderIds = new Set<string>();
  for (const imported of imports) {
    const provider = providers.get(imported.id);
    if (!provider || provider.kind !== imported.kind || provider.version !== imported.version) {
      if (!("required" in imported) || imported.required) missingProviderIds.add(imported.id);
      continue;
    }
    requiredTaskClass = provider.requiredTaskClass ?? requiredTaskClass;
  }
  return {
    profiles,
    imports,
    missingProviderIds: [...missingProviderIds].sort(),
    ...(requiredTaskClass === undefined ? {} : { requiredTaskClass }),
  };
}

export function providerIndex(providers: readonly Provider[]): ReadonlyMap<string, Provider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

/** The one missing-provider rejection, raised identically by resolution and the catalog projection. */
export function missingProviderFailure(ids: readonly string[]): PresetFailure {
  return presetFailure("missing_provider", `Capability providers ${ids.join(", ")} are unavailable.`, ids);
}
