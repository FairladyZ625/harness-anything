import type { ParsedCommand } from "./types.ts";
import { readOption } from "./parse-options.ts";

export function parseGitDiffArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): ParsedCommand | undefined {
  if (args[0] !== "git-diff") return undefined;
  return {
    rootDir,
    json,
    action: {
      kind: "git-diff",
      baseRef: readOption(args, "--base")
    }
  };
}
