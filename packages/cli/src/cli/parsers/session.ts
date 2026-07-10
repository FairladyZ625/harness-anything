import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };
type Runtime = "claude-code" | "codex" | "zcode" | "antigravity";
type Source = "runtime" | "manual";

export function parseSessionArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "session") return null;
  const subcommand = args[1];
  if (subcommand !== "export" && subcommand !== "backfill" && subcommand !== "sync") return null;
  if (subcommand === "sync") {
    return { ok: true, value: { rootDir, json, action: { kind: "session-sync" } } };
  }

  const runtime = readRuntime(args, "--runtime");
  if (runtime === "invalid") {
    return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use --runtime claude-code|codex|zcode|antigravity.") };
  }
  if (subcommand === "backfill") {
    const limit = readPositiveInteger(args, "--limit");
    if (limit === "invalid") return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use a positive integer for --limit.") };
    return { ok: true, value: { rootDir, json, action: { kind: "session-backfill", runtime, limit } } };
  }

  const sessionId = readOption(args, "--session");
  const source = readSource(args, "--source");
  if (source === "invalid") return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use --source runtime|manual.") };
  if (sessionId && !runtime) return { ok: false, error: cliError(CliErrorCode.MissingSession, "Use session export --session <id> --runtime <runtime>.") };
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "session-export",
        sessionId,
        runtime,
        source,
        detectedAt: readOption(args, "--detected-at"),
        user: readOption(args, "--user"),
        transcriptFile: readOption(args, "--transcript-file")
      }
    }
  };
}

function readRuntime(args: ReadonlyArray<string>, flag: string): Runtime | undefined | "invalid" {
  const value = readOption(args, flag);
  if (!value) return undefined;
  if (value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity") return value;
  return "invalid";
}

function readSource(args: ReadonlyArray<string>, flag: string): Source | undefined | "invalid" {
  const value = readOption(args, flag);
  if (!value) return undefined;
  if (value === "runtime" || value === "manual") return value;
  return "invalid";
}

function readPositiveInteger(args: ReadonlyArray<string>, flag: string): number | undefined | "invalid" {
  const value = readOption(args, flag);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : "invalid";
}
