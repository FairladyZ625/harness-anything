import { readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { parseTaskList } from "./core-task-list.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseCoreTaskArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] === "init") {
    const projectName = readRequiredValueOption(args, "--name");
    if (!projectName.ok) return projectName;
    return {
      ok: true,
      value: {
        rootDir,
        json,
        action: {
          kind: "init",
          addNpmScripts: args.includes("--add-npm-scripts"),
          projectName: projectName.value
        }
      }
    };
  }
  if (args[0] === "task" && args[1] === "list") return parseTaskList(args, rootDir, json);
  return null;
}
