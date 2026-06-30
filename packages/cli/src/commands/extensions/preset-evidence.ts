import { writeFileSync } from "node:fs";
import path from "node:path";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function presetScriptAuthorizationRequiredResult(options: {
  readonly rootDir: string;
  readonly evidenceDir: string;
  readonly commandName: "preset-run" | "preset-action";
  readonly presetSummary: unknown;
  readonly presetId: string;
  readonly layer: string;
  readonly taskId: string;
  readonly entrypoint: string;
}): CliResult {
  const evidence = {
    schema: "preset-evidence/v1",
    presetId: options.presetId,
    layer: options.layer,
    taskId: options.taskId,
    entrypoint: options.entrypoint,
    generated: [],
    ok: false,
    scriptAuthorized: false,
    denial: "preset_script_authorization_required"
  };
  writeFileSync(path.join(options.evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  return {
    ok: false,
    command: options.commandName,
    preset: options.presetSummary,
    evidenceBundle: path.relative(options.rootDir, options.evidenceDir).split(path.sep).join("/"),
    report: evidence,
    error: cliError(CliErrorCode.PresetScriptAuthorizationRequired, "Preset script entrypoints require explicit --allow-scripts authorization.")
  };
}
