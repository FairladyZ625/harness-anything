import path from "node:path";
import type { CliResult } from "../../cli/types.ts";
import type { ScriptHostSuccess } from "./script-host.ts";

export function scriptHostCliResult(options: {
  readonly rootDir: string;
  readonly commandName: string;
  readonly script: unknown;
  readonly run: ScriptHostSuccess;
}): CliResult {
  return {
    ok: true,
    command: options.commandName,
    script: options.script,
    runId: options.run.runId,
    evidenceBundle: path.relative(options.rootDir, options.run.runDir).split(path.sep).join("/"),
    generated: options.run.generated,
    warnings: Array.isArray(options.run.scriptedResult.warnings) ? options.run.scriptedResult.warnings : undefined,
    rows: typeof options.run.scriptedResult.rows === "number" ? options.run.scriptedResult.rows : undefined,
    report: options.run.scriptedResult.report ?? options.run.scriptedResult,
    ...(options.run.capabilityReceipt ? { capabilityReceipt: options.run.capabilityReceipt } : {})
  };
}
