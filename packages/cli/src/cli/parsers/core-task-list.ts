import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { readPriorityTier, readTaskWorkKind } from "./task-metadata-options.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskList(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const lessonValue = readOptionalFlagValue(args, "--lesson");
  if (lessonValue && lessonValue !== "present" && lessonValue !== "missing") {
    return { ok: false, error: cliError(CliErrorCode.InvalidLessonFilter, "Use --lesson, --lesson present, or --lesson missing.") };
  }
  const lesson = lessonValue === "missing" ? "missing" : "present";
  const state = readOption(args, "--state");
  const moduleKey = readOption(args, "--module");
  const queue = readOption(args, "--queue");
  const preset = readOption(args, "--preset");
  const workKind = readTaskWorkKind(readOption(args, "--kind"));
  if (!workKind.ok) return { ok: false, error: workKind.error };
  const riskTier = readPriorityTier(readOption(args, "--risk-tier"));
  if (!riskTier.ok) return { ok: false, error: riskTier.error };
  const urgency = readPriorityTier(readOption(args, "--urgency"));
  if (!urgency.ok) return { ok: false, error: urgency.error };
  const review = readOption(args, "--review");
  const search = readOption(args, "--search");
  return taskListOk(rootDir, json, {
    kind: "task-list",
    filters: {
      ...(state ? { state } : {}),
      ...(moduleKey ? { moduleKey } : {}),
      ...(queue ? { queue } : {}),
      ...(preset ? { preset } : {}),
      ...(workKind.value ? { workKind: workKind.value } : {}),
      ...(riskTier.value ? { riskTier: riskTier.value } : {}),
      ...(urgency.value ? { urgency: urgency.value } : {}),
      ...(review ? { review } : {}),
      ...(args.includes("--lesson") ? { lesson } : {}),
      missingMaterials: args.includes("--missing-materials"),
      includeArchived: args.includes("--include-archived"),
      ...(search ? { search } : {})
    }
  });
}

function readOptionalFlagValue(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function taskListOk(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}
