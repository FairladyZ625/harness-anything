import { isDomainStatus } from "../../../../kernel/src/domain/index.ts";
import { slugifyTaskTitle } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseCoreTaskArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "init") return ok(rootDir, json, { kind: "init", addNpmScripts: args.includes("--add-npm-scripts") });
  if (args[0] === "task" && args[1] === "status" && args[2] === "set" && args[3] && args[4]) return parseStatusSet(args, rootDir, json);
  if (args[0] === "task" && args[1] === "progress" && args[2] === "append" && args[3]) return parseProgressAppend(args, rootDir, json);
  if (args[0] === "task" && args[1] === "archive" && args[2]) return parseTaskArchive(args, rootDir, json);
  if (args[0] === "task" && args[1] === "supersede" && args[2]) return parseTaskSupersede(args, rootDir, json);
  if (args[0] === "task" && args[1] === "delete") return parseTaskDelete(args, rootDir, json);
  if (args[0] === "task" && args[1] === "reopen" && args[2]) return parseTaskReopen(args, rootDir, json);
  if (args[0] === "task-review" && args[1]) return parseTaskReview(args, rootDir, json);
  if (args[0] === "task-complete" && args[1]) return parseTaskComplete(args, rootDir, json);
  if (args[0] === "task" && args[1] === "list") return parseTaskList(args, rootDir, json);
  return null;
}

function parseStatusSet(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  if (!isDomainStatus(args[4])) {
    return { ok: false, error: cliError(CliErrorCode.InvalidStatus, `Unknown status: ${args[4]}`) };
  }
  const force = args.includes("--force");
  const reason = readOption(args, "--reason");
  if (force && !reason) {
    return { ok: false, error: cliError(CliErrorCode.MissingForceReason, "Forced terminal status changes require --reason for audit evidence.") };
  }
  return ok(rootDir, json, {
    kind: "status-set",
    taskId: args[3],
    status: args[4],
    force,
    reason
  });
}

function parseProgressAppend(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const text = readOption(args, "--text");
  if (!text) {
    return { ok: false, error: cliError(CliErrorCode.MissingText, "Use --text for progress append.") };
  }
  const evidence = parseEvidence(readOption(args, "--evidence"));
  if (!evidence.ok) return { ok: false, error: evidence.error };
  return ok(rootDir, json, {
    kind: "progress-append",
    taskId: args[3],
    text,
    evidence: evidence.value
  });
}

function parseTaskArchive(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use --reason for task archive.") };
  }
  return ok(rootDir, json, {
    kind: "task-archive",
    taskId: args[2],
    reason,
    archivedBy: readOption(args, "--archived-by"),
    archiveField: readOption(args, "--archive-field")
  });
}

function parseTaskSupersede(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const title = readOption(args, "--title");
  const byTaskId = readOption(args, "--by");
  if (!title && !byTaskId) {
    return { ok: false, error: cliError(CliErrorCode.MissingSupersedeTarget, "Use task supersede <id> --title <title> or --by <existing-task-id>.") };
  }
  if (title && byTaskId) {
    return { ok: false, error: cliError(CliErrorCode.ConflictingSupersedeTarget, "Use either --title or --by, not both.") };
  }
  return ok(rootDir, json, {
    kind: "task-supersede",
    oldTaskId: args[2],
    title,
    slug: title ? readOption(args, "--slug") ?? slugifyTaskTitle(title) : undefined,
    byTaskId,
    confirm: readOption(args, "--confirm"),
    allowOpenFindings: args.includes("--allow-open-findings"),
    deletedBy: readOption(args, "--deleted-by"),
    reason: readOption(args, "--reason") ?? (byTaskId ? `superseded by ${byTaskId}` : "superseded")
  });
}

function parseTaskDelete(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  if (args.includes("--hard") && args.includes("--soft")) {
    return { ok: false, error: cliError(CliErrorCode.ConflictingDeleteMode, "Use exactly one of --soft or --hard for task delete.") };
  }
  const mode = args.includes("--hard") ? "hard" : args.includes("--soft") ? "soft" : null;
  const taskId = args.find((arg, index) => index > 1 && !arg.startsWith("--") && !optionValueFlags.has(args[index - 1]));
  if (!mode) {
    return { ok: false, error: cliError(CliErrorCode.MissingDeleteMode, "Use --soft or --hard for task delete.") };
  }
  if (!taskId) {
    return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Provide a task id for task delete.") };
  }
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use --reason for task delete.") };
  }
  return ok(rootDir, json, {
    kind: "task-delete",
    taskId,
    mode,
    reason,
    confirm: readOption(args, "--confirm"),
    deletedBy: readOption(args, "--deleted-by")
  });
}

function parseTaskReopen(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use --reason for task reopen.") };
  }
  return ok(rootDir, json, {
    kind: "task-reopen",
    taskId: args[2],
    reason
  });
}

function parseTaskReview(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  return ok(rootDir, json, {
    kind: "task-review",
    taskId: args[1],
    reviewerId: readOption(args, "--reviewer") ?? "local-reviewer"
  });
}

function parseTaskComplete(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const ciGate = readOption(args, "--ci");
  if (!ciGate) {
    return { ok: false, error: cliError(CliErrorCode.MissingCiGate, "task-complete requires --ci passed|failed") };
  }
  if (ciGate !== "passed" && ciGate !== "failed") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}`) };
  }
  return ok(rootDir, json, {
    kind: "task-complete",
    taskId: args[1],
    ciGate,
    reviewerId: readOption(args, "--reviewer") ?? "local-reviewer"
  });
}

function parseTaskList(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const lessonValue = readOptionalFlagValue(args, "--lesson");
  if (lessonValue && lessonValue !== "present" && lessonValue !== "missing") {
    return { ok: false, error: cliError(CliErrorCode.InvalidLessonFilter, "Use --lesson, --lesson present, or --lesson missing.") };
  }
  const lesson = lessonValue === "missing" ? "missing" : "present";
  const state = readOption(args, "--state");
  const moduleKey = readOption(args, "--module");
  const queue = readOption(args, "--queue");
  const preset = readOption(args, "--preset");
  const review = readOption(args, "--review");
  const search = readOption(args, "--search");
  return ok(rootDir, json, {
    kind: "task-list",
    filters: {
      ...(state ? { state } : {}),
      ...(moduleKey ? { moduleKey } : {}),
      ...(queue ? { queue } : {}),
      ...(preset ? { preset } : {}),
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

function parseEvidence(value: string | undefined):
  | { readonly ok: true; readonly value?: { readonly type: string; readonly path: string; readonly summary: string } }
  | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (!value) return { ok: true };
  const [type, evidencePath, ...summaryParts] = value.split(":");
  return type && evidencePath && summaryParts.length > 0
    ? { ok: true, value: { type, path: evidencePath, summary: summaryParts.join(":") } }
    : { ok: false, error: cliError(CliErrorCode.InvalidEvidence, "Use --evidence type:PATH:summary.") };
}

function ok(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action
    }
  };
}

const optionValueFlags = new Set(["--reason", "--confirm", "--deleted-by"]);
