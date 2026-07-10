import type { CommandParseResult } from "../command-spec/types.ts";

export function parseVerticalArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): CommandParseResult | null {
  if (args[0] !== "vertical" || args[1] !== "validate") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "vertical-validate",
        definitionPath: args[2]
      }
    }
  };
}
