import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand, TaskListFilters } from "../types.ts";
import { readPriorityTier, readTaskWorkKind } from "./task-metadata-options.ts";
import { bundledVerticalDefinition } from "../../commands/extensions/bundled.ts";

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
  const treeRoot = readOption(args, "--tree-root");
  const liveness = readOption(args, "--liveness");
  if (liveness && liveness !== "in_flight" && liveness !== "stale") {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use --liveness in_flight or --liveness stale.") };
  }
  const livenessFilter = liveness === "in_flight" || liveness === "stale" ? liveness : undefined;
  const fieldExtensions = readFieldExtensionFilters(args);
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
      ...(treeRoot ? { treeRoot } : {}),
      ...(livenessFilter ? { liveness: livenessFilter } : {}),
      ...(review ? { review } : {}),
      ...(args.includes("--lesson") ? { lesson } : {}),
      missingMaterials: args.includes("--missing-materials"),
      includeArchived: args.includes("--include-archived"),
      ...(search ? { search } : {}),
      ...(fieldExtensions.length > 0 ? { fieldExtensions } : {})
    }
  });
}

function readFieldExtensionFilters(args: ReadonlyArray<string>): NonNullable<TaskListFilters["fieldExtensions"]> {
  const vertical = bundledVerticalDefinition();
  return (vertical?.entityFieldExtensions ?? [])
    .filter((extension) => extension.projection.queryable)
    .flatMap((extension) => {
      const value = readOption(args, `--${extension.field}`);
      return value && !value.startsWith("--")
        ? [{ field: extension.field, column: extension.projection.column, value }]
        : [];
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
