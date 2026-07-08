import { cliError, missingRequiredOptionErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

export interface GlobalParseOptions {
  readonly rootDir: string;
  readonly authoredRoot?: string;
  readonly daemonRepoId?: string;
  readonly json: boolean;
  readonly args: ReadonlyArray<string>;
}

export function stripGlobalOptions(argv: ReadonlyArray<string>, cwd = process.cwd()): GlobalParseOptions {
  const rootDir = readOption(argv, "--root") ?? cwd;
  const authoredRoot = readOption(argv, "--authored-root") ?? readNonEmptyProcessEnv("HARNESS_AUTHORED_ROOT");
  const daemonRepoId = readOption(argv, "--repo") ?? readNonEmptyProcessEnv("HARNESS_DAEMON_REPO_ID");
  const json = argv.includes("--json");
  const args = argv.filter((arg, index) => {
    const previous = argv[index - 1];
    return arg !== "--json"
      && arg !== "--root"
      && previous !== "--root"
      && arg !== "--authored-root"
      && previous !== "--authored-root"
      && arg !== "--repo"
      && previous !== "--repo";
  });
  return { rootDir, authoredRoot, daemonRepoId, json, args };
}

function readNonEmptyProcessEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function readOption(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function readRepeatedOption(argv: ReadonlyArray<string>, name: string): ReadonlyArray<string> {
  return argv.flatMap((arg, index) => arg === name && argv[index + 1] && !argv[index + 1].startsWith("--") ? [argv[index + 1]] : []);
}

export function readRepeatedRawOption(argv: ReadonlyArray<string>, name: string): ReadonlyArray<string | undefined> {
  const values: Array<string | undefined> = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) values.push(argv[index + 1]);
  }
  return values;
}

export function readInputOptions(args: ReadonlyArray<string>): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--input") continue;
    const value = args[index + 1] ?? "";
    const separator = value.indexOf("=");
    if (separator <= 0) continue;
    inputs[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return inputs;
}

/**
 * Reads a required value option and rejects a following flag token as a missing value.
 * Optional parsers use readOption directly when flag-like literals are valid values.
 */
export function readRequiredValueOption(argv: ReadonlyArray<string>, name: string): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!argv.includes(name)) return { ok: true };
  const value = readOption(argv, name);
  if (!value || value.startsWith("--")) {
    return {
      ok: false,
      error: cliError(missingRequiredOptionErrorCode(name), `Use ${name} <value>.`)
    };
  }
  return { ok: true, value };
}
