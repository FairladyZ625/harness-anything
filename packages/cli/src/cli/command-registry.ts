import type { CommandRegistryEntry } from "./types.ts";
import { commandReceiptEnvelope } from "./receipt.ts";
import { commandSpecs, type CommandKind, type CommandSpec } from "./command-spec/index.ts";
import type {
  CommandParserId,
  CommandReceiptContract,
  CommandRunnerId
} from "./command-spec/types.ts";

export const cliCommandName = "harness-anything";
export const cliCommandAlias = "ha";

export type {
  CommandKind,
  CommandParserId,
  CommandReceiptContract,
  CommandRunnerId
};

export interface CommandUsage {
  readonly kind: CommandKind;
  readonly usage: string;
  readonly aliases?: ReadonlyArray<string>;
}

type RegisteredCommandKind = CommandKind;

const commandUsages = commandSpecs.map((entry) => ({
  kind: entry.kind,
  usage: entry.usage,
  ...("aliases" in entry ? { aliases: entry.aliases } : {})
})) satisfies ReadonlyArray<CommandUsage>;

const commandSummaries = Object.fromEntries(
  commandSpecs.map((entry) => [entry.kind, entry.summary])
) as Record<CommandKind, string>;

const commandExamples = Object.fromEntries(
  commandSpecs.map((entry) => [entry.kind, entry.examples])
) as unknown as Record<CommandKind, ReadonlyArray<string>>;

const commandSpecsByKind = Object.fromEntries(
  commandSpecs.map((entry) => [entry.kind, entry])
) as unknown as Record<CommandKind, CommandSpec>;

export interface CommandDescriptor extends CommandUsage {
  readonly parserId: CommandParserId;
  readonly runnerId: CommandRunnerId;
  readonly summary: string;
  readonly examples: ReadonlyArray<string>;
  readonly options: CommandSpec["options"];
  readonly receiptContract: CommandReceiptContract;
}

export const commandDescriptors = commandUsages.map((entry) => ({
  kind: entry.kind,
  usage: entry.usage,
  ...("aliases" in entry ? { aliases: entry.aliases } : {}),
  parserId: commandSpecsByKind[entry.kind].parserId,
  runnerId: commandSpecsByKind[entry.kind].runnerId,
  summary: commandSummaries[entry.kind],
  examples: commandExamples[entry.kind],
  options: commandSpecsByKind[entry.kind].options,
  receiptContract: commandSpecsByKind[entry.kind].receiptContract
})) satisfies ReadonlyArray<CommandDescriptor>;

export const commandReceiptContracts = commandDescriptors.map((entry) => ({
  kind: entry.kind,
  ...entry.receiptContract
}));

export const commandRegistry = commandDescriptors.map((entry) => {
  const shortAliases = "aliases" in entry ? entry.aliases ?? [] : [];
  return {
    kind: entry.kind,
    primary: `${cliCommandName} ${entry.usage}`,
    aliases: [
      `${cliCommandAlias} ${entry.usage}`,
      ...shortAliases.map((alias) => `${cliCommandName} ${alias}`),
      ...shortAliases.map((alias) => `${cliCommandAlias} ${alias}`)
    ],
    commandPath: commandPathFromUsage(entry.usage),
    summary: commandSummaries[entry.kind],
    options: entry.options,
    examples: commandExamples[entry.kind],
    resultEnvelope: commandReceiptEnvelope
  };
}) satisfies ReadonlyArray<CommandRegistryEntry>;

export function commandKindsForParser(parserId: CommandParserId): ReadonlyArray<RegisteredCommandKind> {
  return commandDescriptors
    .filter((entry) => entry.parserId === parserId)
    .map((entry) => entry.kind);
}

export function findCommandDescriptorByKind(kind: string): CommandDescriptor | undefined {
  return commandDescriptors.find((entry) => entry.kind === kind);
}

export function runnerIdForAction(kind: CommandKind): CommandRunnerId {
  const descriptor = findCommandDescriptorByKind(kind);
  if (!descriptor) {
    throw new Error(`missing command descriptor for action kind: ${kind}`);
  }
  return descriptor.runnerId;
}

export function findCommandByKind(kind: string): CommandRegistryEntry | undefined {
  return commandRegistry.find((entry) => entry.kind === kind);
}

export function findCommandHelpMatch(tokens: ReadonlyArray<string>):
  | { readonly kind: "global" }
  | { readonly kind: "command"; readonly entry: CommandRegistryEntry }
  | { readonly kind: "prefix"; readonly prefix: ReadonlyArray<string>; readonly entries: ReadonlyArray<CommandRegistryEntry> }
  | { readonly kind: "unknown" } {
  if (tokens.length === 0) return { kind: "global" };

  const exact = commandRegistry.find((entry) => samePath(entry.commandPath, tokens));
  if (exact) return { kind: "command", entry: exact };
  const aliasExact = commandRegistry.find((entry) => entry.aliases.some((alias) => samePath(aliasPathFromDisplay(alias), tokens)));
  if (aliasExact) return { kind: "command", entry: aliasExact };

  const prefixMatches = commandRegistry.filter((entry) => isPrefix(tokens, entry.commandPath) || entry.aliases.some((alias) => isPrefix(tokens, aliasPathFromDisplay(alias))));
  if (prefixMatches.length > 0) return { kind: "prefix", prefix: tokens, entries: prefixMatches };
  return { kind: "unknown" };
}

function commandPathFromUsage(usage: string): ReadonlyArray<string> {
  const tokens = usage.split(/\s+/u);
  const pathTokens: string[] = [];
  for (const token of tokens) {
    if (!token || token.startsWith("[") || token.startsWith("(") || token.startsWith("<") || token.startsWith("--") || token.includes("|")) break;
    pathTokens.push(token);
  }
  return pathTokens;
}

function aliasPathFromDisplay(alias: string): ReadonlyArray<string> {
  const withoutBinary = alias
    .replace(/^harness-anything\s+/u, "")
    .replace(/^ha\s+/u, "");
  const withoutDeprecation = withoutBinary.replace(/\s+\(deprecated,.*$/u, "");
  return commandPathFromUsage(withoutDeprecation);
}

function samePath(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function isPrefix(prefix: ReadonlyArray<string>, pathTokens: ReadonlyArray<string>): boolean {
  return prefix.length < pathTokens.length && prefix.every((token, index) => token === pathTokens[index]);
}
