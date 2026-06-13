import { commandRegistry } from "./command-registry.ts";
import { parseRegisteredCommand } from "./parser-registry.ts";
import { stripGlobalOptions } from "./parse-options.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export function parseArgs(argv: ReadonlyArray<string>): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  const { rootDir, json, args } = stripGlobalOptions(argv);

  const parsed = parseRegisteredCommand(args, rootDir, json);
  if (parsed) return parsed;
  return {
    ok: false,
    error: {
      code: "unknown_command",
      hint: `Supported commands: ${commandRegistry.map((entry) => entry.primary).join("; ")}, template list, template render, preset validate, vertical validate.`
    }
  };
}

export function actionTaskId(action: ParsedCommand["action"]): string | undefined {
  if ("oldTaskId" in action) return action.oldTaskId;
  return "taskId" in action ? action.taskId : undefined;
}
