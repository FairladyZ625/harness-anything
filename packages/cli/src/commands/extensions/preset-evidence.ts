import { writeFileSync } from "node:fs";
import path from "node:path";
import { demotedGateWarning } from "../../cli/demoted-gate-warning.ts";

export function recordPresetScriptAuthorizationWarning(options: {
  readonly evidenceDir: string;
  readonly presetId: string;
  readonly taskId: string;
  readonly entrypoint: string;
}): ReturnType<typeof demotedGateWarning> {
  const warning = demotedGateWarning(
    "preset_script_authorization_required",
    `Preset ${options.presetId} script action ${options.entrypoint} ran without explicit --allow-scripts; sandbox and declared scope enforcement remained active.`
  );
  writeFileSync(path.join(options.evidenceDir, "authorization-warning.json"), JSON.stringify({
    schema: "preset-script-authorization-warning/v1",
    presetId: options.presetId,
    taskId: options.taskId,
    entrypoint: options.entrypoint,
    warning
  }, null, 2), "utf8");
  return warning;
}
