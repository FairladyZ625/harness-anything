import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskContractMigrate(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  if (dryRun === apply) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use exactly one of --dry-run or --apply for task contract migrate.") };
  }
  const taskId = readOption(args, "--task");
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-contract-migrate",
        mode: apply ? "apply" : "dry-run",
        ...(taskId ? { taskId } : {})
      }
    }
  };
}
