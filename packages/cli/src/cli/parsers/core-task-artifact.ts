import { CliErrorCode, cliError } from "../error-codes.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseArtifactAdd(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const sourcePaths = args.slice(4).filter((value) => !value.startsWith("--"));
  if (sourcePaths.length === 0) {
    return { ok: false, error: cliError(CliErrorCode.ArtifactReadFailed, "Use task artifact add <task-id> <path>....") };
  }
  return {
    ok: true,
    value: { rootDir, json, action: { kind: "artifact-add", taskId: args[3]!, sourcePaths } }
  };
}
