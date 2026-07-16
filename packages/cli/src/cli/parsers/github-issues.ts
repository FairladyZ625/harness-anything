import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult =
  | { readonly ok: true; readonly value: ParsedCommand }
  | { readonly ok: false; readonly error: CliResult["error"] };

export function parseGithubIssuesArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): ParseResult | null {
  if (args[0] === "snapshot" && args[1] === "github") {
    const ref = args[2];
    return ref
      ? githubParsed(rootDir, json, { kind: "snapshot-github", ref })
      : missingRef("snapshot github requires owner/repo#number or an issue URL.");
  }
  if (args[0] === "list" && args[1] === "github") {
    const repository = args[2];
    return repository
      ? githubParsed(rootDir, json, {
        kind: "list-github",
        repository,
        rawStatus: readOption(args, "--raw-status"),
        label: readOption(args, "--label")
      })
      : missingRef("list github requires owner/repo.");
  }
  return null;
}

function githubParsed(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}

function missingRef(hint: string): ParseResult {
  return { ok: false, error: cliError(CliErrorCode.RefNotFound, hint) };
}
