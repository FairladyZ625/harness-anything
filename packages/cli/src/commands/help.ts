import { commandRegistry, findCommandByKind } from "../cli/command-registry.ts";
import type { CliResult, CommandRegistryEntry, ParsedCommand } from "../cli/types.ts";

type HelpAction = Extract<ParsedCommand["action"], { readonly kind: "help" }>;

export function buildHelpResult(action: HelpAction): CliResult {
  return {
    ok: true,
    command: "help",
    commands: helpCommands(action),
    report: helpReport(action)
  };
}

function helpCommands(action: HelpAction): ReadonlyArray<CommandRegistryEntry> {
  if (action.commandKind) {
    const entry = findCommandByKind(action.commandKind);
    return entry ? [entry] : [];
  }
  if (action.commandPrefix) {
    return commandRegistry.filter((entry) => action.commandPrefix!.every((token, index) => entry.commandPath[index] === token));
  }
  return commandRegistry;
}

function helpReport(action: HelpAction): CliResult["report"] {
  if (action.commandKind) {
    return { schema: "cli-help-report/v1", kind: "command", commandKind: action.commandKind };
  }
  if (action.commandPrefix) {
    return { schema: "cli-help-report/v1", kind: "prefix", prefix: action.commandPrefix };
  }
  return { schema: "cli-help-report/v1", kind: "global" };
}
