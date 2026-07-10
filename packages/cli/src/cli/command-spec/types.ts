import type { CliResult, ParsedCommand } from "../types.ts";
import type { CommandRunner } from "../runner-registry.ts";

export type CommandParseResult =
  | { readonly ok: true; readonly value: ParsedCommand }
  | { readonly ok: false; readonly error: CliResult["error"] };

export interface CommandDescriptorIdentity {
  readonly kind: string;
  readonly usage: string;
}

export type CommandParser = (
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  commandSpecs: ReadonlyArray<CommandDescriptorIdentity>
) => CommandParseResult | null;

export type RuntimeEventPolicy = "auto" | "direct" | "none" | "deferred";

export interface CommandReceiptContract {
  readonly data: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  readonly optionalData?: Readonly<Record<string, string>>;
  readonly optionalPaths?: Readonly<Record<string, string>>;
}

export interface CommandEventPolicySpec {
  readonly conflictMarkerPreflight: boolean;
  readonly runtimeEvent: RuntimeEventPolicy;
}

export interface CommandOptionDefinition {
  readonly flag: string;
  readonly description: string;
}

export interface CommandSpecDefinition {
  readonly kind: string;
  readonly usage: string;
  readonly options: ReadonlyArray<CommandOptionDefinition>;
  readonly aliases?: ReadonlyArray<string>;
  readonly summary: string;
  readonly examples: ReadonlyArray<string>;
  readonly parse: CommandParser;
  readonly run: CommandRunner;
  readonly receiptContract: CommandReceiptContract;
  readonly eventPolicy: CommandEventPolicySpec;
}

export type ParsedCommandKind = ParsedCommand["action"]["kind"];

export function defineCommandSpecs<const Spec extends ReadonlyArray<CommandSpecDefinition>>(specs: Spec): Spec {
  return specs;
}
