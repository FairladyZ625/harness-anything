type TaskLineageClass = "milestone" | "epic";

// Preset-boundary translation for new packages.
export function taskClassSetByPreset(presetId: string): TaskLineageClass | undefined {
  if (presetId === "create-milestone") return "milestone";
  if (presetId === "long-running-task") return "epic";
  return undefined;
}
