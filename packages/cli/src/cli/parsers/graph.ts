import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseGraphArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "graph") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "graph",
        outputPath: readOption(args, "--out"),
        focus: readOption(args, "--focus"),
        projectionPath: readOption(args, "--projection"),
        includeArchived: args.includes("--include-archived")
      }
    }
  };
}
