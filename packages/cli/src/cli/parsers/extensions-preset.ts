import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parsePresetArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "preset" && args[1] === "validate" && args[2]) {
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "preset-validate",
          manifestPath: args[2],
          kernelVersion: readOption(args, "--kernel-version") ?? "1.0.0"
        }
      }
    };
  }

  if (args[0] === "preset" && args[1] === "list") {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-list" } } };
  }

  if (args[0] === "preset" && args[1] === "inspect" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-inspect", presetId: args[2] } } };
  }

  if (args[0] === "preset" && args[1] === "check" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-check", presetId: args[2] } } };
  }

  if (args[0] === "preset" && args[1] === "install" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-install", sourcePath: args[2], layer: args.includes("--project") ? "project" : "user" } } };
  }

  if (args[0] === "preset" && args[1] === "seed") {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-seed" } } };
  }

  if (args[0] === "preset" && args[1] === "audit") {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-audit" } } };
  }

  if (args[0] === "preset" && args[1] === "uninstall" && args[2]) {
    return { ok: true, value: { rootDir, json, action: { kind: "preset-uninstall", presetId: args[2], layer: args.includes("--project") ? "project" : "user" } } };
  }

  if (args[0] === "preset" && args[1] === "run" && args[2] && args[3]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: { code: "missing_task", hint: "preset run requires --task <id>." } };
    if (args[3] !== "plan" && args[3] !== "scaffold" && args[3] !== "check") {
      return { ok: false, error: { code: "invalid_entrypoint", hint: `Unknown preset entrypoint: ${args[3]}` } };
    }
    return { ok: true, value: { rootDir, json, action: { kind: "preset-run", presetId: args[2], entrypoint: args[3], taskId } } };
  }

  if (args[0] === "preset" && args[1] === "action" && args[2] && args[3]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: { code: "missing_task", hint: "preset action requires --task <id>." } };
    return { ok: true, value: { rootDir, json, action: { kind: "preset-action", presetId: args[2], actionName: args[3], taskId } } };
  }

  return null;
}
