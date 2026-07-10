import type { CommandParseResult } from "../command-spec/types.ts";

export function parseGuiArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): CommandParseResult | null {
  if (args[0] !== "gui") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "gui"
      }
    }
  };
}
