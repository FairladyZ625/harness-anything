import type { PresetManifest } from "@harness-anything/kernel";
import { selectPresetProfile } from "../extensions/state.ts";

export function resolvePresetCompletionGates(
  manifest: PresetManifest,
  presetId: string,
  profileId?: string
): ReadonlyArray<string> {
  const schema: string = manifest.schema;
  if (schema !== "preset-manifest/v2" && schema !== "preset-manifest/v3") {
    throw new Error(`Task preset ${presetId} does not declare a v2/v3 completion contract`);
  }
  const selected = selectPresetProfile(manifest, profileId);
  if (!selected || !("completionGates" in selected)) {
    throw new Error(`Task preset profile is not resolvable: ${profileId ?? manifest.defaultProfile}`);
  }
  return selected.completionGates;
}
