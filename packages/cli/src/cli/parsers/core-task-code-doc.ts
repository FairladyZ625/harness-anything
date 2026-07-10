import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskCodeDocReconcile(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const sha = readOption(args, "--commit");
  if (!sha || !/^[0-9a-f]{40}$/u.test(sha)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task code-doc reconcile requires --commit with a full 40-character commit sha.") };
  }
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--path") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Each --path requires a repository-relative path.") };
    }
    paths.push(value);
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-code-doc-reconcile",
        taskId: args[3]!,
        sha,
        paths,
        prRef: readOption(args, "--pr"),
        force: args.includes("--force")
      }
    }
  };
}
