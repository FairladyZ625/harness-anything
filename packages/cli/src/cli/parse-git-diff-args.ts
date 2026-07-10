import type { CommandParseResult } from "./command-spec/types.ts";
import { readOption } from "./parse-options.ts";

export function parseGitDiffArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): CommandParseResult | null {
  const normalizedArgs = args[0] === "git" && args[1] === "diff" ? ["git-diff", ...args.slice(2)] : args;
  if (normalizedArgs[0] !== "git-diff") return null;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "git-diff",
        baseRef: readOption(normalizedArgs, "--base")
      }
    }
  };
}
