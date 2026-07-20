import { entityRegistryKinds } from "@harness-anything/kernel";
import type { CommandKind } from "./command-spec/index.ts";
import type { CommandDescriptorIdentity } from "./command-spec/types.ts";
import { entityForCommand } from "./command-input-descriptors.ts";

const excludedCommandKinds = [
  "help",
  "version",
  "completion",
  "capabilities",
  "entity-list"
] as const satisfies ReadonlyArray<CommandKind>;

export const capabilityExcludedCommandKinds: ReadonlySet<CommandKind> = new Set(excludedCommandKinds);

export function capabilityEntityKinds(commandDescriptors: ReadonlyArray<CommandDescriptorIdentity>): ReadonlyArray<string> {
  return Object.freeze(
  [...new Set([
    ...entityRegistryKinds,
    ...commandDescriptors
      .filter((descriptor) => !capabilityExcludedCommandKinds.has(descriptor.kind as CommandKind))
      .map(entityForCommand)
  ])].sort((left, right) => left.localeCompare(right))
  );
}
