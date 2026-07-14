import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  PresetManifestSchema,
  validateExtensionInputShape,
  type ExtensionValidationIssue,
  type PresetManifest
} from "../../../../kernel/src/index.ts";

export function readPresetManifestFromSourceResult(sourcePath: string):
  | { readonly ok: true; readonly value: PresetManifest }
  | { readonly ok: false; readonly issues: ReadonlyArray<ExtensionValidationIssue> } {
  const resolved = path.resolve(sourcePath);
  const presetPath = existsSync(path.join(resolved, "preset.json")) ? path.join(resolved, "preset.json") : resolved;
  return decodePresetManifestFileResult(presetPath);
}

export function decodePresetManifestFileResult(presetPath: string):
  | { readonly ok: true; readonly value: PresetManifest }
  | { readonly ok: false; readonly issues: ReadonlyArray<ExtensionValidationIssue> } {
  try {
    const raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
    const shape = validateExtensionInputShape("preset-manifest", raw);
    if (!shape.ok) return { ok: false, issues: shape.issues };
    return { ok: true, value: Schema.decodeUnknownSync(PresetManifestSchema)(raw) };
  } catch (error) {
    return {
      ok: false,
      issues: [{
        code: "unknown_extension_field",
        message: error instanceof Error ? error.message : "Preset manifest failed validation.",
        path: "$"
      }]
    };
  }
}
