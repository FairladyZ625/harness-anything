import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const archiveOptionValueFlags = new Set(["--reason", "--ids", "--filter", "--before", "--archived-by", "--archive-field"]);

export function parseTaskArchive(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const reason = readOption(args, "--reason");
  if (!reason) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use --reason for task archive.") };
  }
  const taskId = args.find((arg, index) => index > 1 && !arg.startsWith("--") && !archiveOptionValueFlags.has(args[index - 1]));
  const ids = readOption(args, "--ids")?.split(",").map((id) => id.trim()).filter(Boolean);
  const filter = readOption(args, "--filter");
  const before = readOption(args, "--before");
  const selectorCount = [taskId, ids && ids.length > 0 ? ids : undefined, filter].filter(Boolean).length;
  if (selectorCount === 0) {
    return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use task archive <id>, --ids <id,id>, or --filter state:<state>.") };
  }
  if (selectorCount > 1) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use exactly one archive selector: positional id, --ids, or --filter.") };
  }
  if (taskId && (ids || filter || before)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use either a positional task id or batch archive selectors, not both.") };
  }
  if (before && !filter) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use --before together with --filter state:<state>.") };
  }
  if (ids && ids.length === 0) {
    return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use --ids <id,id> with at least one task id.") };
  }
  if (filter && !/^state:[A-Za-z0-9_-]+$/u.test(filter)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use --filter state:<state> for task archive.") };
  }
  if (before && Number.isNaN(Date.parse(before))) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use --before <date> with an ISO-compatible date.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-archive",
        ...(taskId ? { taskId } : {}),
        ...(ids ? { ids } : {}),
        ...(filter ? { filter } : {}),
        ...(before ? { before } : {}),
        reason,
        archivedBy: readOption(args, "--archived-by"),
        archiveField: readOption(args, "--archive-field")
      }
    }
  };
}
