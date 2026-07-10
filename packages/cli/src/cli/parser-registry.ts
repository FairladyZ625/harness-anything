import { commandSpecs } from "./command-spec/index.ts";
import type { CommandParseResult, CommandParser } from "./command-spec/types.ts";
import type { ParsedCommand } from "./types.ts";

export type ParseResult = CommandParseResult;

export interface ParserRegistryEntry {
  readonly commandKinds: ReadonlyArray<ParsedCommand["action"]["kind"]>;
  readonly parse: CommandParser;
}

const registeredParsers = [...new Set(commandSpecs.map((spec) => spec.parse))];

export const parserRegistry = registeredParsers.map((parse) => ({
  parse,
  commandKinds: commandSpecs
    .filter((spec) => spec.parse === parse)
    .map((spec) => spec.kind)
})) satisfies ReadonlyArray<ParserRegistryEntry>;

export function parseRegisteredCommand(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  for (const entry of parserRegistry) {
    const parsed = entry.parse(args, rootDir, json, commandSpecs);
    if (parsed) return parsed;
  }
  return null;
}
