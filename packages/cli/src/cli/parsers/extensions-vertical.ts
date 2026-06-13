import type { ParsedCommand } from "../types.ts";

export function parseVerticalArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParsedCommand | null {
  if (args[0] !== "vertical" || args[1] !== "validate") return null;
  return {
    rootDir,
    json,
    action: {
      kind: "vertical-validate",
      definitionPath: args[2]
    }
  };
}
