import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { isFactMemoryClass, isFactMemoryTag, type FactMemoryTag } from "../../../../kernel/src/index.ts";

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
  const memoryClass = readOption(args, "--memory-class") ?? "episodic";
  const memoryTags = readMemoryTags(args);
  if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use record fact --task <task-id>.") };
  if (!statement) return { ok: false, error: cliError(CliErrorCode.MissingFactStatement, "Use record fact --statement <text>.") };
  if (!source) return { ok: false, error: cliError(CliErrorCode.MissingFactSource, "Use record fact --source <text>.") };
  if (!confidenceLevels.has(confidence)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactConfidence, "Use low, medium, or high for --confidence.") };
  }
  if (!isFactMemoryClass(memoryClass)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactMemoryClass, "Use semantic, episodic, or procedural for --memory-class.") };
  }
  if (memoryTags === null) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactMemoryTag, "Use known fact memory tags with --memory-tag.") };
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
        memoryClass,
        memoryTags,
        dryRun: args.includes("--dry-run")
      }
    }
  };
}

function readMemoryTags(args: ReadonlyArray<string>): ReadonlyArray<FactMemoryTag> | null {
  const rawTags: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--memory-tag") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return null;
    rawTags.push(...value.split(",").map((tag) => tag.trim()).filter(Boolean));
  }
  if (rawTags.some((tag) => !isFactMemoryTag(tag))) return null;
  return rawTags as ReadonlyArray<FactMemoryTag>;
}
