import { Effect } from "effect";
import { entityRegistry, entityRegistryKinds } from "../../../../kernel/src/index.ts";
import { cliCommandAlias, commandDescriptors, commandRegistry, type CommandKind } from "../../cli/command-registry.ts";
import { actionForCommand, commandInputDescriptorFor, entityForCommand } from "../../cli/command-input-descriptors.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

export const capabilityExcludedCommandKinds = new Set<CommandKind>([
  "help",
  "version",
  "capabilities",
  "entity-list"
] as const);

export const runCapabilitiesCommand: CommandRunner = (_context, command) => {
  const action = command.action as Extract<ParsedCommand["action"], { readonly kind: "entity-list" | "capabilities" }>;
  return Effect.sync(() => action.kind === "entity-list" ? entityListResult() : capabilitiesResult(action.entityKind));
};

function entityListResult(): CliResult {
  const items = [...entities().values()].map((entity) => ({
    kind: entity.kind,
    storage: storageForEntity(entity.kind),
    description: descriptionForEntity(entity.kind),
    ops: entity.ops.map((op) => op.action),
    capabilitiesCommand: `${cliCommandAlias} ${entity.kind} capabilities --json`
  }));
  return { ok: true, command: "entity-list", rows: items.length, report: { schema: "entity-list/v1", items } };
}

function capabilitiesResult(entityKind: string | undefined): CliResult {
  const all = entities();
  if (!entityKind) {
    const items = [...all.values()].map((entity) => ({ kind: entity.kind, ops: entity.ops.length, capabilitiesCommand: `${cliCommandAlias} ${entity.kind} capabilities --json` }));
    return { ok: true, command: "capabilities", rows: items.length, report: { schema: "capabilities-index/v1", items } };
  }
  const entity = all.get(entityKind) ?? { kind: entityKind, ops: [] };
  return {
    ok: true,
    command: "capabilities",
    rows: entity.ops.length,
    report: {
      schema: "entity-capabilities/v1",
      kind: entity.kind,
      storage: storageForEntity(entity.kind),
      description: descriptionForEntity(entity.kind),
      fields: fieldsForEntity(entity.kind),
      anchors: entity.kind === "decision" ? [{ name: "CH/RJ/C", description: "Decision chosen/rejected/claim anchors may host relation endpoints." }] : [],
      disposition: dispositionForEntity(entity.kind),
      ops: entity.ops,
      examples: entity.ops.flatMap((op) => op.examples.map((example) => ({ command: example }))),
      generatedFrom: {
        commandRegistry: "packages/cli/src/cli/command-registry.ts",
        inputDescriptors: "packages/cli/src/cli/command-input-descriptors.ts"
      }
    }
  };
}

function entities(): Map<string, { readonly kind: string; readonly ops: ReadonlyArray<Record<string, unknown> & { readonly action: string; readonly examples: ReadonlyArray<string> }> }> {
  const byEntity = new Map<string, Array<Record<string, unknown> & { readonly action: string; readonly examples: ReadonlyArray<string> }>>();
  for (const descriptor of commandDescriptors) {
    if (capabilityExcludedCommandKinds.has(descriptor.kind)) continue;
    const entity = entityForCommand(descriptor);
    const input = commandInputDescriptorFor(descriptor);
    const registryEntry = commandRegistry.find((entry) => entry.kind === descriptor.kind);
    const op = {
      commandKind: descriptor.kind,
      name: input.action,
      action: input.action,
      command: registryEntry?.aliases.find((alias) => alias.startsWith(`${cliCommandAlias} `)) ?? `${cliCommandAlias} ${descriptor.usage}`,
      description: descriptor.summary,
      input: input.input,
      shortcuts: input.shortcuts,
      output: { receiptSchema: "command-receipt/v2", itemKind: entity },
      examples: descriptor.examples
    };
    byEntity.set(entity, [...(byEntity.get(entity) ?? []), op]);
  }
  for (const kind of entityRegistryKinds) {
    if (!byEntity.has(kind)) byEntity.set(kind, []);
  }
  return new Map([...byEntity.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([kind, ops]) => [kind, { kind, ops }]));
}

function fieldsForEntity(kind: string): ReadonlyArray<Record<string, unknown>> {
  const fieldNames = new Set<string>();
  for (const descriptor of commandDescriptors.filter((entry) => entityForCommand(entry) === kind)) {
    for (const property of Object.keys(commandInputDescriptorFor(descriptor).input.properties)) fieldNames.add(property);
  }
  return [...fieldNames].sort().map((name) => ({
    name,
    readable: true,
    writableBy: commandDescriptors
      .filter((entry) => entityForCommand(entry) === kind && commandInputDescriptorFor(entry).input.properties[name])
      .map((entry) => `${entityForCommand(entry)} ${actionForCommand(entry)}`),
    jsonPath: `$.${name}`
  }));
}

function storageForEntity(kind: string): string {
  if (isRegisteredEntityKind(kind)) return entityRegistry[kind].storageForm;
  if (kind === "doc" || kind === "template") return "schema";
  return "composite";
}

function descriptionForEntity(kind: string): string {
  const descriptions: Record<string, string> = {
    decision: "Architecture and product decisions with lifecycle state and rationale.",
    task: "Task packages and lifecycle workflow state.",
    fact: "Task-local factual evidence anchors.",
    event: "Runtime event JSONL records.",
    session: "Managed exported runtime session markdown documents.",
    doc: "Canonical document manifest and module read-set derivation.",
    graph: "Generated relation graph inspection artifacts over the SQLite projection.",
    module: "Registered project module metadata."
  };
  return descriptions[kind] ?? `Capabilities for ${kind} commands.`;
}

function dispositionForEntity(kind: string): ReadonlyArray<Record<string, unknown>> {
  if (!isRegisteredEntityKind(kind)) return [];
  return Object.values(entityRegistry[kind].dispositionMatrix.entries)
    .filter((entry) => entry.supported)
    .sort((left, right) => `${left.level}:${left.action}`.localeCompare(`${right.level}:${right.action}`))
    .map((entry) => ({
      level: entry.level,
      name: entry.action,
      commands: entry.writeOpKinds.map(commandForWriteOpKind),
      soTCheckRequired: true,
      description: entry.reason
    }));
}

function commandForWriteOpKind(kind: string): string {
  const commands: Record<string, string> = {
    decision_retire: "ha decision retire <id>",
    decision_supersede: "ha decision supersede <id>",
    package_archive: "ha task archive <id> --reason <reason>",
    package_tombstone: "ha task delete --soft <id> --reason <reason>",
    package_delete_hard: "ha task delete --hard <id> --confirm <id> --reason <reason>",
    package_supersede: "ha task supersede <old-id> --title <title> --reason <reason>",
    fact_invalidate: "ha fact invalidate --task <task-id> --id <fact-id> --by <fact-id> --rationale <text>",
    relation_retire: "ha decision relation retire <decision-id> --relation <relation-id>"
  };
  return commands[kind] ?? kind;
}

function isRegisteredEntityKind(kind: string): kind is typeof entityRegistryKinds[number] {
  return (entityRegistryKinds as ReadonlyArray<string>).includes(kind);
}
