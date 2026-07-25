import type { PresetManifest } from "../schemas/registry.ts";

export interface PresetOutputShapeIssue {
  readonly code: "invalid_output_shape_completion_gates";
  readonly message: string;
  readonly path: string;
}

export function validatePresetOutputShape(
  preset: PresetManifest,
  presetIndex: number
): ReadonlyArray<PresetOutputShapeIssue> {
  if (preset.schema === "preset-manifest/v1") return [];
  if (preset.schema === "preset-manifest/v2" && !preset.outputShape) return [];
  const issues: PresetOutputShapeIssue[] = [];
  for (const [profileIndex, profile] of preset.profiles.entries()) {
    const path = `presets[${presetIndex}].profiles[${profileIndex}].completionGates`;
    if (preset.outputShape === "repository-diff" && !profile.completionGates.includes("ci")) {
      issues.push({
        code: "invalid_output_shape_completion_gates",
        message: `Preset ${preset.id} produces a repository diff, so profile ${profile.id} must declare the ci completion gate.`,
        path
      });
    }
    if (
      preset.outputShape === "task-package-artifact"
      && profile.completionGates.some((gate) => gate === "ci" || gate === "code-doc-reconciliation")
    ) {
      issues.push({
        code: "invalid_output_shape_completion_gates",
        message: `Preset ${preset.id} produces a task-package artifact, so profile ${profile.id} cannot declare ci or code-doc-reconciliation.`,
        path
      });
    }
  }
  return issues;
}
