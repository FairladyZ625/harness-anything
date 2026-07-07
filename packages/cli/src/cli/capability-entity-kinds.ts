import { entityRegistryKinds } from "../../../kernel/src/index.ts";
import { commandDescriptors, type CommandKind } from "./command-registry.ts";
import { entityForCommand } from "./command-input-descriptors.ts";

export const capabilityExcludedCommandKinds = new Set<CommandKind>([
  "help",
  "version",
  "capabilities",
  "entity-list"
] as const);

export const capabilityEntityKinds = Object.freeze(
  [...new Set([
    ...entityRegistryKinds,
    ...commandDescriptors
      .filter((descriptor) => !capabilityExcludedCommandKinds.has(descriptor.kind))
      .map(entityForCommand)
  ])].sort((left, right) => left.localeCompare(right))
);
