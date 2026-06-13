import type { ParsedCommand } from "./types.ts";

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

function readOption(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
