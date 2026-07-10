import { domainStatuses, isDomainStatus } from "../../../../kernel/src/index.ts";
import { slugifyTaskTitle } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption, readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { parseTaskArchive } from "./core-task-archive.ts";
import { parseTaskCodeDocReconcile } from "./core-task-code-doc.ts";
import { parseTaskList } from "./core-task-list.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseCoreTaskArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "init") {
    const projectName = readRequiredValueOption(args, "--name");
    if (!projectName.ok) return projectName;
    return ok(rootDir, json, {
      kind: "init",
      addNpmScripts: args.includes("--add-npm-scripts"),
      projectName: projectName.value
    });
  }
  if (args[0] === "task" && args[1] === "claim" && args[2]) return parseTaskClaim(args, rootDir, json);
  if (args[0] === "task" && args[1] === "holder" && args[2]) return ok(rootDir, json, { kind: "task-holder", taskId: args[2] });
  if (args[0] === "task" && args[1] === "release" && args[2]) return ok(rootDir, json, { kind: "task-release", taskId: args[2] });
  if (args[0] === "task" && args[1] === "transition" && args[2] && args[3]) return parseStatusSet(["task", "status", "set", ...args.slice(2)], rootDir, json);
  if (args[0] === "task" && args[1] === "status" && args[2] === "set" && args[3] && args[4]) return parseStatusSet(args, rootDir, json);
  if (args[0] === "task" && args[1] === "progress" && args[2] === "append" && args[3]) return parseProgressAppend(args, rootDir, json);
  if (args[0] === "task" && args[1] === "amend" && args[2]) return parseTaskAmend(args, rootDir, json);
  if (args[0] === "task" && args[1] === "archive") return parseTaskArchive(args, rootDir, json);
  if (args[0] === "task" && args[1] === "supersede" && args[2]) return parseTaskSupersede(args, rootDir, json);
  if (args[0] === "task" && args[1] === "delete") return parseTaskDelete(args, rootDir, json);
  if (args[0] === "task" && args[1] === "reopen" && args[2]) return parseTaskReopen(args, rootDir, json);
  if (args[0] === "task" && args[1] === "code-doc" && args[2] === "reconcile" && args[3]) return parseTaskCodeDocReconcile(args, rootDir, json);
  if (args[0] === "task" && args[1] === "review" && args[2]) return parseTaskReview(["task-review", ...args.slice(2)], rootDir, json);
  if (args[0] === "task-review" && args[1]) return parseTaskReview(args, rootDir, json);
  if (args[0] === "task" && args[1] === "complete" && args[2]) return parseTaskComplete(["task-complete", ...args.slice(2)], rootDir, json);
  if (args[0] === "task-complete" && args[1]) return parseTaskComplete(args, rootDir, json);
  if (args[0] === "task" && args[1] === "show" && args[2]) return ok(rootDir, json, { kind: "task-show", taskId: args[2] });
  if (args[0] === "task" && args[1] === "tree" && args[2]) return ok(rootDir, json, { kind: "task-tree", taskId: args[2] });
  if (args[0] === "task" && args[1] === "relate" && args[2] && args[3] && args[4]) return parseTaskRelate(args, rootDir, json);
  if (args[0] === "task" && args[1] === "list") return parseTaskList(args, rootDir, json);
  return null;
}

function parseTaskClaim(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const ttlValue = readOption(args, "--ttl-ms");
  let ttlMs: number | undefined;
  if (ttlValue !== undefined) {
    ttlMs = Number(ttlValue);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use --ttl-ms with a positive integer.") };
    }
  }
  return ok(rootDir, json, {
    kind: "task-claim",
    taskId: args[2],
    ...(ttlMs !== undefined ? { ttlMs } : {})
  });
}

function parseStatusSet(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  if (!isDomainStatus(args[4])) {
    return { ok: false, error: cliError(CliErrorCode.InvalidStatus, `Unknown status: ${args[4]}. Valid statuses: ${domainStatuses.join(", ")}.`) };
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
  const evidence = parseEvidence(readRepeatedRawOption(args, "--evidence"));
  if (!evidence.ok) return { ok: false, error: evidence.error };
  return ok(rootDir, json, {
    kind: "progress-append",
    taskId: args[3],
    text,
    evidence: evidence.value
  });
}

function parseTaskAmend(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const patches = args.flatMap((token, index) => token === "--set" ? parseTaskAmendSet(args[index + 1]) : []);
  if (patches.length === 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use task amend <id> --set <field>:<value>.") };
  }
  return ok(rootDir, json, {
    kind: "task-amend",
    taskId: args[2]!,
    patches
  });
}

function parseTaskAmendSet(raw: string | undefined): ReadonlyArray<{ readonly field: string; readonly value: string }> {
  if (!raw || raw.startsWith("--")) return [];
  const separator = raw.indexOf(":");
  if (separator <= 0) return [];
  const field = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  return field && value ? [{ field, value }] : [];
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
    return { ok: false, error: cliError(CliErrorCode.MissingCiGate, "task complete requires --ci passed|failed") };
  }
  if (ciGate !== "passed" && ciGate !== "failed") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}. Valid CI gate values: passed, failed.`) };
  }
  return ok(rootDir, json, {
    kind: "task-complete",
    taskId: args[1],
    ciGate,
    reviewerId: readOption(args, "--reviewer") ?? "local-reviewer"
  });
}

function parseTaskRelate(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  if (args[3] !== "depends-on") {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskRelation, "Only task->task depends-on relations are writable through task relate.") };
  }
  const rationale = readOption(args, "--rationale") ?? readOption(args, "--reason");
  if (!rationale) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "task relate requires --rationale <text>.") };
  }
  return ok(rootDir, json, {
    kind: "task-relate",
    sourceTaskId: args[2],
    relationType: "depends-on",
    targetTaskId: args[4],
    rationale,
    dryRun: args.includes("--dry-run")
  });
}

function parseEvidence(values: ReadonlyArray<string | undefined>):
  | { readonly ok: true; readonly value?: ReadonlyArray<{ readonly type: string; readonly path: string; readonly summary: string }> }
  | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (values.length === 0) return { ok: true };
  const evidence: Array<{ readonly type: string; readonly path: string; readonly summary: string }> = [];
  for (const value of values) {
    if (!value) return { ok: false, error: cliError(CliErrorCode.InvalidEvidence, "Use --evidence type:PATH:summary.") };
    const [type, evidencePath, ...summaryParts] = value.split(":");
    if (!type || !evidencePath || summaryParts.length === 0) {
      return { ok: false, error: cliError(CliErrorCode.InvalidEvidence, "Use --evidence type:PATH:summary.") };
    }
    evidence.push({ type, path: evidencePath, summary: summaryParts.join(":") });
  }
  return { ok: true, value: evidence };
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

const optionValueFlags = new Set(["--reason", "--confirm", "--deleted-by", "--rationale", "--ids", "--filter", "--before", "--archived-by", "--archive-field"]);
