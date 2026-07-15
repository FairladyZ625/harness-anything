import type { CliResult, CommandRegistryEntry, ParsedCommand } from "../cli/types.ts";
import { daemonHelpRegistryEntry } from "./daemon/help.ts";

type HelpAction = Extract<ParsedCommand["action"], { readonly kind: "help" }>;

export function buildHelpResult(action: HelpAction, commandRegistry: ReadonlyArray<CommandRegistryEntry>): CliResult {
  return {
    ok: true,
    command: "help",
    commands: helpCommands(action, commandRegistry),
    report: helpReport(action)
  };
}

function helpCommands(action: HelpAction, commandRegistry: ReadonlyArray<CommandRegistryEntry>): ReadonlyArray<CommandRegistryEntry> {
  if (action.commandKind) {
    const entry = commandRegistry.find((candidate) => candidate.kind === action.commandKind);
    return entry ? [entry] : [];
  }
  if (action.commandPrefix) {
    return commandRegistry.filter((entry) => action.commandPrefix!.every((token, index) => entry.commandPath[index] === token));
  }
  return [...commandRegistry, daemonHelpRegistryEntry];
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
