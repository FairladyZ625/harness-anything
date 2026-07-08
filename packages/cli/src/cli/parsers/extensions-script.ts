import { cliError, CliErrorCode } from "../error-codes.ts";
import { readInputOptions, readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const scriptSources = new Set(["user", "vertical", "preset"]);
const scriptPurposes = new Set(["scaffold", "generate", "transform", "audit"]);
const scriptKinds = new Set(["action", "check"]);

export function parseScriptArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "script") return null;
  if (args[1] === "list") {
    const source = readOption(args, "--source");
    const purpose = readOption(args, "--purpose");
    const scriptKind = readOption(args, "--kind");
    if (source && !scriptSources.has(source)) return { ok: false, error: cliError(CliErrorCode.InvalidScriptFilter, "Unknown script source filter.") };
    if (purpose && !scriptPurposes.has(purpose)) return { ok: false, error: cliError(CliErrorCode.InvalidScriptFilter, "Unknown script purpose filter.") };
    if (scriptKind && !scriptKinds.has(scriptKind)) return { ok: false, error: cliError(CliErrorCode.InvalidScriptFilter, "Unknown script kind filter.") };
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "script-list",
          ...(source ? { source: source as "user" | "vertical" | "preset" } : {}),
          ...(purpose ? { purpose: purpose as "scaffold" | "generate" | "transform" | "audit" } : {}),
          ...(scriptKind ? { scriptKind: scriptKind as "action" | "check" } : {})
        }
      }
    };
  }
  if (args[1] === "inspect" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "script-inspect", scriptId: args[2] } } };
  }
  if (args[1] === "run" && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "script-run",
          scriptId: args[2],
          taskId: readOption(args, "--task"),
          dryRun: args.includes("--dry-run"),
          inputs: readInputOptions(args)
        }
      }
    };
  }
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use script list, script inspect <id>, or script run <id>.") };
}
