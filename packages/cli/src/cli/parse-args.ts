import { commandRegistry, findCommandHelpMatch } from "./command-registry.ts";
import { parseRegisteredCommand } from "./parser-registry.ts";
import { stripGlobalOptions } from "./parse-options.ts";
import { setHarnessLayoutOverrides } from "../../../kernel/src/layout/index.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export function parseArgs(argv: ReadonlyArray<string>): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  const { rootDir, authoredRoot, json, args } = stripGlobalOptions(argv);
  setHarnessLayoutOverrides({ authoredRoot });

  const help = parseHelpRequest(args, rootDir, json);
  if (help) return help;

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

function parseHelpRequest(args: ReadonlyArray<string>, rootDir: string, json: boolean): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } | null {
  if (args.length === 0) {
    return { ok: true, value: { rootDir, json, action: { kind: "help" } } };
  }

  const first = args[0] ?? "";
  const isExplicitHelpCommand = first === "help";
  const hasHelpFlag = args.includes("--help") || args.includes("-h");
  if (!isExplicitHelpCommand && !hasHelpFlag) return null;

  const topic = isExplicitHelpCommand
    ? args.slice(1)
    : args.filter((arg) => arg !== "--help" && arg !== "-h");
  const match = findCommandHelpMatch(topic);
  if (match.kind === "global") {
    return { ok: true, value: { rootDir, json, action: { kind: "help" } } };
  }
  if (match.kind === "command") {
    return { ok: true, value: { rootDir, json, action: { kind: "help", commandKind: match.entry.kind } } };
  }
  if (match.kind === "prefix") {
    return { ok: true, value: { rootDir, json, action: { kind: "help", commandPrefix: match.prefix } } };
  }
  return {
    ok: false,
    error: {
      code: "unknown_help_topic",
      hint: `Unknown help topic: ${topic.join(" ")}`
    }
  };
}

export function actionTaskId(action: ParsedCommand["action"]): string | undefined {
  if ("oldTaskId" in action) return action.oldTaskId;
  return "taskId" in action ? action.taskId : undefined;
}
