import type { ParsedCommand } from "../types.ts";

export function parseGuiArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParsedCommand | null {
  if (args[0] !== "gui") return null;
  return {
    rootDir,
    json,
    action: {
      kind: "gui"
    }
  };
}
