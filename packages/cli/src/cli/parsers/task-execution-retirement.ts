import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult =
  | { readonly ok: true; readonly value: ParsedCommand }
  | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskRetireExecution(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): ParseResult {
  const executionId = readOption(args, "--execution-id");
  const reason = readOption(args, "--reason");
  if (!executionId) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use task retire-execution <task-id> --execution-id <execution-id> --reason <reason>.") };
  }
  if (!reason) {
    return { ok: false, error: cliError(CliErrorCode.MissingReason, "Execution retirement requires --reason for audit evidence.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-retire-execution",
        taskId: args[2],
        executionId,
        reason,
        retiredAt: new Date().toISOString()
      }
    }
  };
}
