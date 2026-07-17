import { commandSpecs, type CommandKind } from "./command-spec/index.ts";
import type { CommandParseResult, CommandParser } from "./command-spec/types.ts";
import type { CommandJsonInput } from "./json-input.ts";

export type ParseResult = CommandParseResult;

export interface ParserRegistryEntry {
  readonly commandKinds: ReadonlyArray<CommandKind>;
  readonly parse: CommandParser;
}

const registeredParsers = [...new Set(commandSpecs.map((spec) => spec.parse))];

export const parserRegistry = registeredParsers.map((parse) => ({
  parse,
  commandKinds: commandSpecs
    .filter((spec) => spec.parse === parse)
    .map((spec) => spec.kind)
})) satisfies ReadonlyArray<ParserRegistryEntry>;

export function parseRegisteredCommand(args: ReadonlyArray<string>, rootDir: string, json: boolean, input?: CommandJsonInput): ParseResult | null {
  for (const entry of parserRegistry) {
    const parsed = entry.parse(args, rootDir, json, commandSpecs, input);
    if (parsed) return parsed;
  }
  return null;
}
