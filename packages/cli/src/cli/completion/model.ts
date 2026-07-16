import type { CommandRegistryEntry } from "../types.ts";

export interface CompletionCandidate {
  readonly value: string;
  readonly description: string;
}

export interface CompletionOption extends CompletionCandidate {
  readonly values: ReadonlyArray<string>;
}

export interface CompletionPositional {
  readonly index: number;
  readonly values: ReadonlyArray<string>;
}

export interface CompletionCommand {
  readonly path: ReadonlyArray<string>;
  readonly summary: string;
  readonly options: ReadonlyArray<CompletionOption>;
  readonly positionals: ReadonlyArray<CompletionPositional>;
}

export interface CompletionNode {
  readonly path: ReadonlyArray<string>;
  readonly children: ReadonlyArray<CompletionCandidate>;
}

export interface ShellCompletionModel {
  readonly commands: ReadonlyArray<CompletionCommand>;
  readonly nodes: ReadonlyArray<CompletionNode>;
}

interface CompletionCommandGroup {
  readonly path: ReadonlyArray<string>;
  readonly summaries: string[];
  readonly options: Map<string, CompletionOption>;
  readonly positionals: Map<number, Set<string>>;
}

export function deriveShellCompletionModel(registry: ReadonlyArray<CommandRegistryEntry>): ShellCompletionModel {
  const byPath = new Map<string, CompletionCommandGroup>();

  for (const entry of registry) {
    if (entry.commandPath.length === 0) continue;
    const key = pathKey(entry.commandPath);
    const group: CompletionCommandGroup = byPath.get(key) ?? {
      path: entry.commandPath,
      summaries: [],
      options: new Map(),
      positionals: new Map()
    };
    group.summaries.push(entry.summary);
    for (const option of entry.options) {
      const existing = group.options.get(option.flag);
      const values = unique([...(existing?.values ?? []), ...optionValues(entry.primary, option.flag)]);
      group.options.set(option.flag, {
        value: option.flag,
        description: existing?.description ?? option.description,
        values
      });
    }
    for (const positional of positionalValues(entry)) {
      const values = group.positionals.get(positional.index) ?? new Set<string>();
      for (const value of positional.values) values.add(value);
      group.positionals.set(positional.index, values);
    }
    byPath.set(key, group);
  }

  const commands = [...byPath.values()]
    .map((group): CompletionCommand => ({
      path: group.path,
      summary: group.summaries[0] ?? `${group.path.at(-1) ?? "command"} command`,
      options: [...group.options.values()],
      positionals: [...group.positionals.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, values]) => ({ index, values: [...values] }))
    }))
    .sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)));

  return { commands, nodes: deriveNodes(commands) };
}

function deriveNodes(commands: ReadonlyArray<CompletionCommand>): ReadonlyArray<CompletionNode> {
  const prefixes = new Map<string, ReadonlyArray<string>>([["", []]]);
  for (const command of commands) {
    for (let length = 1; length < command.path.length; length += 1) {
      const prefix = command.path.slice(0, length);
      prefixes.set(pathKey(prefix), prefix);
    }
  }
  return [...prefixes.values()]
    .map((prefix) => {
      const children = new Map<string, CompletionCandidate>();
      for (const command of commands) {
        if (!isCompletionPathPrefix(prefix, command.path)) continue;
        const value = command.path[prefix.length];
        if (!value || children.has(value)) continue;
        const childPath = [...prefix, value];
        const exact = commands.find((candidate) => sameCompletionPath(candidate.path, childPath));
        children.set(value, {
          value,
          description: exact?.summary ?? `${value} commands`
        });
      }
      return {
        path: prefix,
        children: [...children.values()].sort((left, right) => left.value.localeCompare(right.value))
      };
    })
    .sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)));
}

function optionValues(usage: string, flag: string): ReadonlyArray<string> {
  const pattern = new RegExp(`(?:^|[\\s[(|])${escapeRegex(flag)}\\s+([^\\s]+)`, "gu");
  for (const match of usage.matchAll(pattern)) {
    const values = literalAlternatives(match[1] ?? "");
    if (values.length > 1) return values;
  }
  return [];
}

function positionalValues(entry: CommandRegistryEntry): ReadonlyArray<CompletionPositional> {
  const tokens = entry.primary.split(/\s+/u).slice(1 + entry.commandPath.length);
  const result: CompletionPositional[] = [];
  let positionalIndex = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "|" || token === ";") continue;
    const flags = token.match(/--[a-z][a-z0-9-]*/giu) ?? [];
    if (flags.length > 0) {
      if (flags.length === 1 && normalizedFlag(token) === flags[0] && tokens[index + 1] && !/--[a-z]/iu.test(tokens[index + 1]!)) {
        index += 1;
      }
      continue;
    }
    const values = literalAlternatives(token);
    if (values.length > 1) result.push({ index: positionalIndex, values });
    positionalIndex += 1;
  }
  return result;
}

function literalAlternatives(expression: string): ReadonlyArray<string> {
  const normalized = expression
    .replace(/^[<\u005b({]+/u, "")
    .replace(/\.\.\.$/u, "")
    .replace(/[>\])},;]+$/u, "");
  if (!normalized.includes("|")) return [];
  const values = normalized.split("|");
  return values.length > 1 && values.every((value) => /^[A-Za-z0-9_./:-]+$/u.test(value))
    ? unique(values)
    : [];
}

function normalizedFlag(token: string): string {
  return token.replace(/^[\u005b({]+/u, "").replace(/[\])},;]+$/u, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function pathKey(path: ReadonlyArray<string>): string {
  return path.join(" ");
}

function sameCompletionPath(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function isCompletionPathPrefix(prefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return prefix.length < path.length && prefix.every((token, index) => token === path[index]);
}
