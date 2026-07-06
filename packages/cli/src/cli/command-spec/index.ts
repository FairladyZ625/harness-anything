import { coreCommandSpecs } from "./command-spec-core.ts";
import { decisionsCommandSpecs } from "./command-spec-decisions.ts";
import { extensionsCommandSpecs } from "./command-spec-extensions.ts";
import { migrationDiagnosticsCommandSpecs } from "./command-spec-migration-diagnostics.ts";
import { runtimeDocsCommandSpecs } from "./command-spec-runtime-docs.ts";
import type { CommandSpecDefinition, ParsedCommandKind } from "./types.ts";

export const commandSpecs = [
  ...coreCommandSpecs,
  ...decisionsCommandSpecs,
  ...runtimeDocsCommandSpecs,
  ...migrationDiagnosticsCommandSpecs,
  ...extensionsCommandSpecs
] as const satisfies ReadonlyArray<CommandSpecDefinition>;

export type CommandSpec = (typeof commandSpecs)[number];
export type CommandKind = CommandSpec["kind"];

type MissingParsedCommandSpec = Exclude<ParsedCommandKind, CommandKind>;
const parsedCommandKindsHaveSpecs = true satisfies MissingParsedCommandSpec extends never ? true : never;
void parsedCommandKindsHaveSpecs;

export function commandSpecMap<Value>(
  select: (spec: CommandSpec) => Value
): Record<CommandKind, Value> {
  return Object.fromEntries(commandSpecs.map((spec) => [spec.kind, select(spec)])) as Record<CommandKind, Value>;
}
