import { aliasPathFromDisplay, commandRegistry } from "./command-registry.ts";
import { globalCommandOptions } from "./command-spec/command-groups.ts";
import { commandSpecs } from "./command-spec/index.ts";
import { specialCommandOptionClaims } from "./command-spec/special-command-option-claims.ts";
import type { CommandOptionDefinition } from "./command-spec/types.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult, CommandRegistryEntry } from "./types.ts";

export interface ResolvedCommandOptionClaim {
  readonly kind: string;
  readonly commandPath: ReadonlyArray<string>;
  readonly options: ReadonlyArray<CommandOptionDefinition>;
  readonly inlineValueOptions: ReadonlyArray<string>;
}

export type CommandOptionValidation =
  | { readonly ok: true; readonly claim?: ResolvedCommandOptionClaim }
  | { readonly ok: false; readonly error: CliResult["error"] };

const globalOptions = globalCommandOptions.map((option) => ({
  ...option,
  token: optionFlagToken(option.flag),
  takesValue: /\s/u.test(option.flag)
}));

const registeredCandidates = commandRegistry.flatMap((entry) => [
  candidate(entry, entry.commandPath),
  ...entry.aliases.map((alias) => candidate(entry, aliasPathFromDisplay(alias)))
]);

const specialCandidates = specialCommandOptionClaims.flatMap((claim) => claim.commandPaths.map((commandPath) => ({
  kind: claim.kind,
  commandPath,
  options: claim.options,
  inlineValueOptions: []
})));

const optionClaimCandidates = [...registeredCandidates, ...specialCandidates]
  .sort((left, right) => right.commandPath.length - left.commandPath.length);

export function validateCommandOptions(argv: ReadonlyArray<string>): CommandOptionValidation {
  const claim = resolveCommandOptionClaim(argv);
  const legalOptions: ReadonlyArray<CommandOptionDefinition> = [
    ...globalCommandOptions,
    ...(claim?.options ?? [])
  ];
  const legalByToken = new Map(legalOptions.map((option) => [optionFlagToken(option.flag), option]));
  const commandLongTokens = new Set(claim?.commandPath.filter((token) => token.startsWith("--")) ?? []);

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const exact = legalByToken.get(arg);
    if (exact) continue;
    const inlineSeparator = arg.indexOf("=");
    const baseToken = inlineSeparator > 0 ? arg.slice(0, inlineSeparator) : arg;
    const inline = legalByToken.get(baseToken);
    if (inline && claim?.inlineValueOptions.includes(baseToken)) continue;
    if (commandLongTokens.has(arg)) continue;

    const suggestion = nearestOption(baseToken, [...legalByToken.keys()]);
    const command = claim?.commandPath.join(" ") || "ha";
    return {
      ok: false,
      error: cliError(
        CliErrorCode.UnknownOption,
        `Unknown option '${arg}' for '${command}'. Did you mean '${suggestion}'?`
      )
    };
  }
  return claim ? { ok: true, claim } : { ok: true };
}

export function resolveCommandOptionClaim(argv: ReadonlyArray<string>): ResolvedCommandOptionClaim | undefined {
  const commandArgs = removeGlobalOptions(argv);
  return optionClaimCandidates.find((entry) => startsWithPath(commandArgs, entry.commandPath));
}

export function optionFlagToken(flag: string): string {
  return flag.split(/\s/u, 1)[0] ?? flag;
}

function candidate(entry: CommandRegistryEntry, commandPath: ReadonlyArray<string>): ResolvedCommandOptionClaim {
  const spec = commandSpecs.find((candidate) => candidate.kind === entry.kind);
  const hiddenOptions = spec && "hiddenOptions" in spec ? spec.hiddenOptions ?? [] : [];
  return {
    kind: entry.kind,
    commandPath,
    options: [...entry.options, ...hiddenOptions],
    inlineValueOptions: spec && "inlineValueOptions" in spec ? spec.inlineValueOptions ?? [] : []
  };
}

function removeGlobalOptions(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = globalOptions.find((candidate) => candidate.token === argv[index]);
    if (!option) {
      args.push(argv[index]!);
      continue;
    }
    if (option.takesValue) index += 1;
  }
  return args;
}

function startsWithPath(args: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  return path.length > 0 && path.every((token, index) => args[index] === token);
}

function nearestOption(attempted: string, legal: ReadonlyArray<string>): string {
  return [...legal].sort((left, right) => {
    const distance = editDistance(attempted, left) - editDistance(attempted, right);
    return distance === 0 ? left.localeCompare(right) : distance;
  })[0] ?? "--help";
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}
