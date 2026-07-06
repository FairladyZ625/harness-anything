import type { ParseResult } from "../parser-registry.ts";

export function parseMaterializerArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "materializer") return null;
  if (args[1] !== "run") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "materializer-run",
        dryRun: args.includes("--dry-run")
      }
    }
  };
}
