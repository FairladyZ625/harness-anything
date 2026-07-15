import { legacyPhysicalScopeWarning, type PresetManifest } from "../../../../kernel/src/index.ts";
import type { CliResult } from "../../cli/types.ts";

export function withPresetRuntimeWarning(result: CliResult, manifest: PresetManifest): CliResult {
  if (manifest.schema === "preset-manifest/v3") return result;
  return { ...result, warnings: [...(result.warnings ?? []), legacyPhysicalScopeWarning(manifest.id)] };
}
