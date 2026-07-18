import { coreCommandSpecs } from "./command-spec-core.ts";
import { projectionReaderCommandSpecs } from "./command-spec-projection-readers.ts";
import { decisionsCommandSpecs } from "./command-spec-decisions.ts";
import { extensionsCommandSpecs } from "./command-spec-extensions.ts";
import { migrationDiagnosticsCommandSpecs } from "./command-spec-migration-diagnostics.ts";
import { runtimeDocsCommandSpecs } from "./command-spec-runtime-docs.ts";
import { completionCommandSpecs } from "./command-spec-completion.ts";
import { githubIssuesCommandSpecs } from "./command-spec-github-issues.ts";
import { authorityCutoverCommandSpecs } from "./command-spec-authority-cutover.ts";
import type { CommandSpecDefinition, ParsedCommandKind } from "./types.ts";
import {
  attachProductionAuthorityIngress,
  type CommandSpecWithProductionAuthorityIngress
} from "./production-authority-ingress.ts";

export const commandSpecs = [
  ...authorityCutoverCommandSpecs,
  ...completionCommandSpecs,
  ...githubIssuesCommandSpecs,
  ...projectionReaderCommandSpecs,
  ...coreCommandSpecs,
  ...decisionsCommandSpecs,
  ...runtimeDocsCommandSpecs,
  ...migrationDiagnosticsCommandSpecs,
  ...extensionsCommandSpecs
] as const satisfies ReadonlyArray<CommandSpecDefinition>;

export const productionAuthorityCommandSpecs = attachProductionAuthorityIngress(commandSpecs);

export type CommandSpec = (typeof commandSpecs)[number];
export type ProductionAuthorityCommandSpec = CommandSpecWithProductionAuthorityIngress<CommandSpec>;
export type CommandKind = CommandSpec["kind"];

type MissingParsedCommandSpec = Exclude<ParsedCommandKind, CommandKind>;
const parsedCommandKindsHaveSpecs = true satisfies MissingParsedCommandSpec extends never ? true : never;
void parsedCommandKindsHaveSpecs;

export function commandSpecMap<Value>(
  select: (spec: CommandSpec) => Value
): Record<CommandKind, Value> {
  return Object.fromEntries(commandSpecs.map((spec) => [spec.kind, select(spec)])) as Record<CommandKind, Value>;
}

export function productionAuthorityIngressFor(kind: string) {
  return productionAuthorityCommandSpecs.find((spec) => spec.kind === kind)?.productionAuthorityIngress;
}

export function productionAuthorityTypedIngressKinds(): ReadonlyArray<string> {
  return productionAuthorityCommandSpecs
    .filter((spec) => spec.productionAuthorityIngress?.status === "typed-v2")
    .map((spec) => spec.kind)
    .sort();
}

export function productionAuthorityUnsupportedHint(rejectedKind: string): string {
  return `production canonical ingress rejected ${rejectedKind}; typed V2 command kinds from command-spec: ${productionAuthorityTypedIngressKinds().join(", ")}`;
}

export {
  assertProductionAuthorityIngressCompleteness,
  productionAuthorityIngressDecisionRef,
  type ProductionAuthorityIngressAdapter,
  type ProductionAuthorityIngressDisposition
} from "./production-authority-ingress.ts";
