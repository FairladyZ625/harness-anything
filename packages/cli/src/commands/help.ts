import type { CliResult, CommandRegistryEntry, ParsedCommand } from "../cli/types.ts";
import { commandGroups } from "../cli/command-spec/command-groups.ts";
import { commandSpecs } from "../cli/command-spec/index.ts";
import type { CommandDisplayTier, CommandSpecDefinition } from "../cli/command-spec/types.ts";
import { migrationCommandDeprecation } from "../cli/command-deprecations.ts";

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
    return entry ? [helpEntry(entry)] : [];
  }
  if (action.commandPrefix) {
    return commandRegistry
      .filter((entry) => displayForKind(entry.kind) === "default")
      .filter((entry) => action.commandPrefix!.every((token, index) => entry.commandPath[index] === token))
      .map(helpEntry);
  }
  return commandGroups
    .filter((group) => group.display === "default")
    .map((group) => ({
      kind: `help-group:${group.name}`,
      primary: group.name,
      aliases: [],
      commandPath: [group.name],
      summary: group.summary,
      options: [],
      examples: [],
      resultEnvelope: "command-receipt/v2"
    }));
}

function helpEntry(entry: CommandRegistryEntry): CommandRegistryEntry {
  return {
    ...entry,
    summary: migrationCommandDeprecation(entry.kind)
      ? `${entry.summary} Deprecated — sunset stage 1/3; use the Legacy Intake flow.`
      : entry.summary,
    primary: withoutGlobalJson(entry.primary),
    aliases: entry.aliases
      .filter((alias) => aliasDisplayForKind(entry.kind, alias) !== "hidden")
      .map(withoutGlobalJson),
    options: entry.options.filter((option) => option.flag !== "--json")
  };
}

function withoutGlobalJson(usage: string): string {
  return usage.replace(/ \[--json\]/gu, "").replace(/ --json$/u, "");
}

function displayForKind(kind: string): CommandDisplayTier {
  return specForKind(kind)?.display ?? "default";
}

function aliasDisplayForKind(kind: string, displayedAlias: string): CommandDisplayTier {
  const spec = specForKind(kind);
  if (!spec?.aliasDisplay) return "default";
  const rawAlias = Object.keys(spec.aliasDisplay).find((alias) => displayedAlias.endsWith(` ${alias}`));
  return rawAlias ? spec.aliasDisplay[rawAlias] ?? "default" : "default";
}

function specForKind(kind: string): CommandSpecDefinition | undefined {
  return commandSpecs.find((candidate) => candidate.kind === kind) as CommandSpecDefinition | undefined;
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
