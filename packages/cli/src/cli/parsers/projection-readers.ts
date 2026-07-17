import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseProjectionReaderArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "session" && args[1] === "show" && args[2]) {
    const view = readOption(args, "--view") ?? "summary";
    if (view === "summary" || view === "trace") return parsed(rootDir, json, { kind: "session-show", sessionId: args[2], view });
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, `Unknown session view: ${view}. Use summary or trace.`) };
  }
  if (args[0] === "session" && args[1] === "trace" && args[2]) return parsed(rootDir, json, { kind: "session-show", sessionId: args[2], view: "trace" });
  if (args[0] === "execution" && args[1] === "show" && args[2]) return parsed(rootDir, json, { kind: "execution-show", executionId: args[2] });
  if (args[0] === "execution" && args[1] === "list") {
    const taskId = readOption(args, "--task");
    return taskId ? parsed(rootDir, json, { kind: "execution-list", taskId }) : missingTask();
  }
  if (args[0] === "task" && args[1] === "trace" && args[2]) return parsed(rootDir, json, { kind: "task-show", taskId: args[2], view: "trace" });
  if (args[0] === "review" && args[1] === "show" && args[2]) return parsed(rootDir, json, { kind: "review-show", reviewId: args[2] });
  if (args[0] === "audit" && args[1] === "provenance") {
    const taskId = readOption(args, "--task");
    return taskId ? parsed(rootDir, json, { kind: "audit-provenance", taskId }) : missingTask();
  }
  return null;
}

function parsed(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}

function missingTask(): ParseResult {
  return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use --task <task-id>.") };
}
