import { legacyPhysicalScopeWarning, type PresetManifest } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function withPresetRuntimeWarning(result: CliResult, manifest: PresetManifest): CliResult {
  if (manifest.schema === "preset-manifest/v3") return result;
  return { ...result, warnings: [...(result.warnings ?? []), legacyPhysicalScopeWarning(manifest.id)] };
}

export function semanticPresetRuntimeUnavailable(command: string, preset: unknown): CliResult {
  return {
    ok: false,
    command,
    preset,
    error: cliError(CliErrorCode.PresetRuntimeUnavailable, "Preset v3 semantic capability execution is not registered in this Phase 0 runtime.")
  };
}
