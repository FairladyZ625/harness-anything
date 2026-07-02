import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const confidenceLevels = new Set(["low", "medium", "high"]);

export function parseRecordArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "record") return null;
  if (args[1] !== "fact") {
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use record fact.") };
  }
  const taskId = readOption(args, "--task") ?? args[2];
  const statement = readOption(args, "--statement");
  const source = readOption(args, "--source");
  const confidence = readOption(args, "--confidence") ?? "medium";
  if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use record fact --task <task-id>.") };
  if (!statement) return { ok: false, error: cliError(CliErrorCode.MissingFactStatement, "Use record fact --statement <text>.") };
  if (!source) return { ok: false, error: cliError(CliErrorCode.MissingFactSource, "Use record fact --source <text>.") };
  if (!confidenceLevels.has(confidence)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactConfidence, "Use low, medium, or high for --confidence.") };
  }
  const factId = readOption(args, "--id");
  if (factId && !/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(factId)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactId, "Use fact ids as F-<8 Crockford base32 chars>.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "record-fact",
        taskId,
        factId,
        statement,
        source,
        observedAt: readOption(args, "--observed-at"),
        confidence: confidence as "low" | "medium" | "high",
        dryRun: args.includes("--dry-run")
      }
    }
  };
}
