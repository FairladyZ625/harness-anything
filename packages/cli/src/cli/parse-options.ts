import type { CliResult } from "./types.ts";

export interface GlobalParseOptions {
  readonly rootDir: string;
  readonly json: boolean;
  readonly args: ReadonlyArray<string>;
}

export function stripGlobalOptions(argv: ReadonlyArray<string>, cwd = process.cwd()): GlobalParseOptions {
  const rootDir = readOption(argv, "--root") ?? cwd;
  const json = argv.includes("--json");
  const args = argv.filter((arg, index) => {
    const previous = argv[index - 1];
    return arg !== "--json" && arg !== "--root" && previous !== "--root";
  });
  return { rootDir, json, args };
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
      error: {
        code: `missing_${name.slice(2).replace(/-/gu, "_")}`,
        hint: `Use ${name} <value>.`
      }
    };
  }
  return { ok: true, value };
}
