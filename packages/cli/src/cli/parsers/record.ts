import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { isFactMemoryClass, isFactMemoryTag, type FactMemoryTag } from "../../../../kernel/src/index.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const confidenceLevels = new Set(["low", "medium", "high"]);

export function parseRecordArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  const normalizedArgs = args[0] === "fact" && args[1] === "record" ? ["record", "fact", ...args.slice(2)] : args;
  if (normalizedArgs[0] !== "record") return null;
  if (normalizedArgs[1] !== "fact") {
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use fact record.") };
  }
  const taskId = readOption(normalizedArgs, "--task") ?? normalizedArgs[2];
  const statement = readOption(normalizedArgs, "--statement");
  const source = readOption(normalizedArgs, "--source");
  const confidence = readOption(normalizedArgs, "--confidence") ?? "medium";
  const memoryClass = readOption(normalizedArgs, "--memory-class") ?? "episodic";
  const memoryTags = readMemoryTags(normalizedArgs);
  if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use fact record --task <task-id>.") };
  if (!statement) return { ok: false, error: cliError(CliErrorCode.MissingFactStatement, "Use fact record --statement <text>.") };
  if (!source) return { ok: false, error: cliError(CliErrorCode.MissingFactSource, "Use fact record --source <text>.") };
  if (!confidenceLevels.has(confidence)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactConfidence, "Use low, medium, or high for --confidence.") };
  }
  if (!isFactMemoryClass(memoryClass)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactMemoryClass, "Use semantic, episodic, or procedural for --memory-class.") };
  }
  if (memoryTags === null) {
    return { ok: false, error: cliError(CliErrorCode.InvalidFactMemoryTag, "Use known fact memory tags with --memory-tag.") };
  }
  const factId = readOption(normalizedArgs, "--id");
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
        observedAt: readOption(normalizedArgs, "--observed-at"),
        confidence: confidence as "low" | "medium" | "high",
        memoryClass,
        memoryTags,
        dryRun: normalizedArgs.includes("--dry-run")
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
