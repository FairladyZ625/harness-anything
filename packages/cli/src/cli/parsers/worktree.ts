import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseWorktreeArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "worktree") return null;
  if (args[1] === "create") return parseWorktreeCreate(args, rootDir, json);
  if (args[1] === "status") return parseWorktreeStatus(args, rootDir, json);
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use worktree create or worktree status.") };
}

function parseWorktreeCreate(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const taskId = readOption(args, "--task");
  if (!taskId) {
    return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "worktree create requires --task <task-id>.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "worktree-create",
        taskId,
        agent: readOption(args, "--agent"),
        branchPrefix: readOption(args, "--branch-prefix"),
        baseRef: readOption(args, "--base"),
        worktreePath: readOption(args, "--path")
      }
    }
  };
}

function parseWorktreeStatus(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const taskId = readOption(args, "--task");
  if (!taskId) {
    return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "worktree status requires --task <task-id>.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "worktree-status",
        taskId
      }
    }
  };
}
