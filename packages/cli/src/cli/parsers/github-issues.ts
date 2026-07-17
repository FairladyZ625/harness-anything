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
  if (args[0] === "external" && args[1] === "snapshot") {
    if (args[2] === "github") return parseGithubSnapshot(args[3], rootDir, json);
    if (args[2] === "multica") return parseMulticaSnapshot(args[3], args, rootDir, json);
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use external snapshot <github|multica> <ref>.") };
  }
  if (args[0] === "external" && args[1] === "list") {
    if (args[2] === "github") return parseGithubList(args[3], args, rootDir, json);
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use external list github <owner/repo>.") };
  }
  if (args[0] === "snapshot" && args[1] === "github") {
    return parseGithubSnapshot(args[2], rootDir, json);
  }
  if (args[0] === "snapshot" && args[1] === "multica") {
    return parseMulticaSnapshot(args[2], args, rootDir, json);
  }
  if (args[0] === "list" && args[1] === "github") {
    return parseGithubList(args[2], args, rootDir, json);
  }
  return null;
}

function parseGithubSnapshot(ref: string | undefined, rootDir: string, json: boolean): ParseResult {
  return ref
    ? githubParsed(rootDir, json, { kind: "external-snapshot", provider: "github", ref })
    : missingRef("snapshot github requires owner/repo#number or an issue URL.");
}

function parseMulticaSnapshot(ref: string | undefined, args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  return ref
    ? githubParsed(rootDir, json, {
      kind: "external-snapshot",
      provider: "multica",
      ref,
      title: readOption(args, "--title") ?? `Multica ${ref}`,
      status: readOption(args, "--status") ?? "Todo",
      url: readOption(args, "--url") ?? ""
    })
    : missingRef("snapshot multica requires a ref.");
}

function parseGithubList(repository: string | undefined, args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  return repository
    ? githubParsed(rootDir, json, {
      kind: "external-list",
      provider: "github",
      repository,
      rawStatus: readOption(args, "--raw-status"),
      label: readOption(args, "--label")
    })
    : missingRef("list github requires owner/repo.");
}

function githubParsed(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}

function missingRef(hint: string): ParseResult {
  return { ok: false, error: cliError(CliErrorCode.RefNotFound, hint) };
}
