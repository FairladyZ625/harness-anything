import { isDomainStatus } from "../../../../kernel/src/domain/index.ts";
import { slugifyTaskTitle } from "../../../../kernel/src/layout/index.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseCoreTaskArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "init") return ok(rootDir, json, { kind: "init" });
  if (args[0] === "task" && args[1] === "status" && args[2] === "set" && args[3] && args[4]) return parseStatusSet(args, rootDir, json);
  if (args[0] === "task" && args[1] === "progress" && args[2] === "append" && args[3]) return parseProgressAppend(args, rootDir, json);
  if (args[0] === "task" && args[1] === "archive" && args[2]) return parseTaskArchive(args, rootDir, json);
  if (args[0] === "task" && args[1] === "supersede" && args[2]) return parseTaskSupersede(args, rootDir, json);
  if (args[0] === "task" && args[1] === "delete") return parseTaskDelete(args, rootDir, json);
  if (args[0] === "task" && args[1] === "reopen" && args[2]) return parseTaskReopen(args, rootDir, json);
  if (args[0] === "task-review" && args[1]) return parseTaskReview(args, rootDir, json);
  if (args[0] === "task-complete" && args[1]) return parseTaskComplete(args, rootDir, json);
  if (args[0] === "task" && args[1] === "list") return ok(rootDir, json, { kind: "task-list" });
  return null;
}

function parseStatusSet(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  if (!isDomainStatus(args[4])) {
    return { ok: false, error: { code: "invalid_status", hint: `Unknown status: ${args[4]}` } };
  }
  const force = args.includes("--force");
  const reason = readOption(args, "--reason");
  if (force && !reason) {
    return { ok: false, error: { code: "missing_force_reason", hint: "Forced terminal status changes require --reason for audit evidence." } };
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
    return { ok: false, error: { code: "missing_text", hint: "Use --text for progress append." } };
  }
  return ok(rootDir, json, {
    kind: "progress-append",
    taskId: args[3],
    text
  });
}

function parseTaskArchive(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: { code: "missing_reason", hint: "Use --reason for task archive." } };
  }
  return ok(rootDir, json, {
    kind: "task-archive",
    taskId: args[2],
    reason
  });
}

function parseTaskSupersede(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const title = readOption(args, "--title");
  if (!title) {
    return { ok: false, error: { code: "missing_title", hint: "Use --title for task supersede." } };
  }
  return ok(rootDir, json, {
    kind: "task-supersede",
    oldTaskId: args[2],
    title,
    slug: readOption(args, "--slug") ?? slugifyTaskTitle(title),
    reason: readOption(args, "--reason") ?? "superseded"
  });
}

function parseTaskDelete(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  if (args.includes("--hard") && args.includes("--soft")) {
    return { ok: false, error: { code: "conflicting_delete_mode", hint: "Use exactly one of --soft or --hard for task delete." } };
  }
  const mode = args.includes("--hard") ? "hard" : args.includes("--soft") ? "soft" : null;
  const taskId = args.find((arg, index) => index > 1 && !arg.startsWith("--") && args[index - 1] !== "--reason");
  if (!mode) {
    return { ok: false, error: { code: "missing_delete_mode", hint: "Use --soft or --hard for task delete." } };
  }
  if (!taskId) {
    return { ok: false, error: { code: "missing_task_id", hint: "Provide a task id for task delete." } };
  }
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: { code: "missing_reason", hint: "Use --reason for task delete." } };
  }
  return ok(rootDir, json, {
    kind: "task-delete",
    taskId,
    mode,
    reason
  });
}

function parseTaskReopen(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: { code: "missing_reason", hint: "Use --reason for task reopen." } };
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
    return { ok: false, error: { code: "missing_ci_gate", hint: "task-complete requires --ci passed|failed" } };
  }
  if (ciGate !== "passed" && ciGate !== "failed") {
    return { ok: false, error: { code: "invalid_ci_gate", hint: `Unknown CI gate: ${ciGate}` } };
  }
  return ok(rootDir, json, {
    kind: "task-complete",
    taskId: args[1],
    ciGate,
    reviewerId: readOption(args, "--reviewer") ?? "local-reviewer"
  });
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
