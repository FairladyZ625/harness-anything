import { isFactMemoryClass, isFactMemoryTag, type FactMemoryTag } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const confidenceLevels = new Set(["low", "medium", "high"]);

export function parseDistillArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "distill") return null;
  if (args[1] === "candidate") return parseDistillCandidate(args, rootDir, json);
  if (args[1] === "commit") return parseDistillCommit(args, rootDir, json);
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use distill candidate or distill commit.") };
}

function parseDistillCandidate(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const taskId = readOption(args, "--task");
  const inputPath = readOption(args, "--input");
  if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use distill candidate --task <task-id>.") };
  if (!inputPath) return { ok: false, error: cliError(CliErrorCode.ArtifactReadFailed, "Use distill candidate --input <path>.") };
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "distill-candidate",
        taskId,
        inputPath
      }
    }
  };
}

function parseDistillCommit(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const taskId = readOption(args, "--task");
  const candidatePath = readOption(args, "--candidate");
  const claim = readOption(args, "--claim");
  const confidence = readOption(args, "--confidence") ?? "medium";
  const memoryClass = readOption(args, "--memory-class") ?? "semantic";
  const memoryTags = readDistillMemoryTags(args);
  if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use distill commit --task <task-id>.") };
  if (!candidatePath) return { ok: false, error: cliError(CliErrorCode.ArtifactReadFailed, "Use distill commit --candidate <path>.") };
  if (!claim) return { ok: false, error: cliError(CliErrorCode.MissingText, "Use distill commit --claim <text>.") };
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
        kind: "distill-commit",
        taskId,
        candidatePath,
        claim,
        factId,
        observedAt: readOption(args, "--observed-at"),
        confidence: confidence as "low" | "medium" | "high",
        memoryClass,
        memoryTags
      }
    }
  };
}

function readDistillMemoryTags(args: ReadonlyArray<string>): ReadonlyArray<FactMemoryTag> | null {
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
