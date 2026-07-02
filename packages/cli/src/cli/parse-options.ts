import { cliError, missingRequiredOptionErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

export interface GlobalParseOptions {
  readonly rootDir: string;
  readonly authoredRoot?: string;
  readonly json: boolean;
  readonly args: ReadonlyArray<string>;
}

export function stripGlobalOptions(argv: ReadonlyArray<string>, cwd = process.cwd()): GlobalParseOptions {
  const rootDir = readOption(argv, "--root") ?? cwd;
  const authoredRoot = readOption(argv, "--authored-root") ?? nonEmptyEnv("HARNESS_AUTHORED_ROOT");
  const json = argv.includes("--json");
  const args = argv.filter((arg, index) => {
    const previous = argv[index - 1];
    return arg !== "--json"
      && arg !== "--root"
      && previous !== "--root"
      && arg !== "--authored-root"
      && previous !== "--authored-root";
  });
  return { rootDir, authoredRoot, json, args };
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function readOption(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

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
