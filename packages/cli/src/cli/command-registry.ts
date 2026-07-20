import type { CommandRegistryEntry } from "./types.ts";
import { commandReceiptEnvelope } from "@harness-anything/application";
import { commandSpecs, type CommandKind, type CommandSpec } from "./command-spec/index.ts";
import type { CommandReceiptContract } from "./command-spec/types.ts";
import { cliCommandAlias, cliCommandName } from "./command-names.ts";

export { cliCommandAlias, cliCommandName };

export type {
  CommandKind,
  CommandReceiptContract
};

export type CommandDescriptor = CommandSpec;

export const commandDescriptors = commandSpecs;

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
    summary: entry.summary,
    options: entry.options,
    examples: entry.examples,
    resultEnvelope: commandReceiptEnvelope
  };
}) satisfies ReadonlyArray<CommandRegistryEntry>;

export function findCommandDescriptorByKind(kind: string): CommandDescriptor | undefined {
  return commandDescriptors.find((entry) => entry.kind === kind);
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

export function findCommandHelpContext(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  const paths = commandRegistry.flatMap((entry) => [
    entry.commandPath,
    ...entry.aliases.map(aliasPathFromDisplay)
  ]);
  let best: ReadonlyArray<string> = [];
  for (const candidate of paths) {
    let length = 0;
    while (length < tokens.length && length < candidate.length && tokens[length] === candidate[length]) length += 1;
    if (length > best.length) best = candidate.slice(0, length);
  }
  return best;
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
