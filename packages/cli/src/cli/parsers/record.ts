import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { isFactMemoryClass, isFactMemoryTag, type FactMemoryTag } from "../../../../kernel/src/index.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const confidenceLevels = new Set(["low", "medium", "high"]);

export function parseRecordArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "fact") return parseFactArgs(args, rootDir, json);
  const normalizedArgs = args;
  if (normalizedArgs[0] !== "record") return null;
  if (normalizedArgs[1] !== "fact") {
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use fact record.") };
  }
  return parseFactRecord(["fact", "record", ...normalizedArgs.slice(2)], rootDir, json);
}

function parseFactArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const op = args[1];
  if (op === "record") return parseFactRecord(args, rootDir, json);
  if (op === "list") {
    const taskId = readOption(args, "--task") ?? args[2];
    if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use fact list --task <task-id>.") };
    return { ok: true, value: { rootDir, json, action: { kind: "fact-list", taskId } } };
  }
  if (op === "show") {
    const taskId = readOption(args, "--task");
    const factId = readOption(args, "--id") ?? args[2];
    if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use fact show --task <task-id> --id <fact-id>.") };
    if (!factId || !/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(factId)) {
      return { ok: false, error: cliError(CliErrorCode.InvalidFactId, "Use fact ids as F-<8 Crockford base32 chars>.") };
    }
    return { ok: true, value: { rootDir, json, action: { kind: "fact-show", taskId, factId } } };
  }
  if (op === "invalidate") {
    const taskId = readOption(args, "--task");
    const factId = readOption(args, "--id") ?? args[2];
    const invalidatedByFactId = readOption(args, "--by");
    const rationale = readOption(args, "--rationale");
    if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use fact invalidate --task <task-id> --id <fact-id> --by <fact-id> --rationale <text>.") };
    if (!factId || !/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(factId)) {
      return { ok: false, error: cliError(CliErrorCode.InvalidFactId, "Use fact ids as F-<8 Crockford base32 chars>.") };
    }
    if (!invalidatedByFactId || !/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(invalidatedByFactId)) {
      return { ok: false, error: cliError(CliErrorCode.InvalidFactId, "Use --by F-<8 Crockford base32 chars>.") };
    }
    if (!rationale || rationale.trim().length === 0) {
      return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use fact invalidate --rationale <text>.") };
    }
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "fact-invalidate",
          taskId,
          factId,
          invalidatedByFactId,
          rationale,
          dryRun: args.includes("--dry-run")
        }
      }
    };
  }
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use fact list|show|record|invalidate.") };
}

function parseFactRecord(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const normalizedArgs = args;
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
