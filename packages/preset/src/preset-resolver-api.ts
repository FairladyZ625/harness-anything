import { effectiveCatalog } from "./preset-catalog.ts";
import {
  defaultBundled,
  key,
  presetFailure,
} from "./preset-resolver-common.ts";
import type { PresetResolverOptions } from "./preset-resolver-types.ts";
import { createRuntime } from "./preset-runtime.ts";
import type {
  CanonicalPresetResolver,
  PresetManifestV3,
} from "./preset.contract.ts";
import path from "node:path";

export function createCanonicalPresetResolver(
  options: PresetResolverOptions,
): CanonicalPresetResolver {
  return createRuntime(options).resolver;
}

export function readInstalledPresetManifest(input: {
  readonly userRoot: string;
  readonly presetId: string;
  readonly verticalId: string;
}): PresetManifestV3 {
  const selected = effectiveCatalog(
    defaultBundled,
    path.resolve(input.userRoot),
  ).get(key(input.verticalId, input.presetId));
  if (!selected?.decoded)
    throw (
      selected?.error ??
      presetFailure(
        "preset_not_found",
        `Preset ${input.presetId} is not installed.`,
      )
    );
  return selected.decoded.manifest;
}
