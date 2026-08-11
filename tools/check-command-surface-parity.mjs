#!/usr/bin/env node

import { Effect } from "effect";
import { pathToFileURL } from "node:url";
import { commandDescriptors, commandRegistry } from "../packages/cli/src/cli/command-registry.ts";
import { capabilityExcludedCommandKinds, runCapabilitiesCommand } from "../packages/cli/src/commands/core/capabilities.ts";
import { daemonCapabilityOperations } from "../packages/cli/src/commands/daemon/help.ts";
import { buildHelpResult } from "../packages/cli/src/commands/help.ts";

export function collectCommandSurfaceParity() {
  const context = { commandDescriptors, commandRegistry };
  const index = Effect.runSync(runCapabilitiesCommand(context, {
    action: { kind: "capabilities", entityKind: undefined }
  }));
  const capabilities = index.report.items.flatMap((item) => {
    const result = Effect.runSync(runCapabilitiesCommand(context, {
      action: { kind: "capabilities", entityKind: item.kind }
    }));
    return result.report.ops;
  });
  const packagedHelp = commandDescriptors.flatMap((descriptor) => {
    const result = buildHelpResult({ kind: "help", commandKind: descriptor.kind }, commandRegistry);
    return result.commands ?? [];
  });
  return {
    descriptors: commandDescriptors,
    registry: commandRegistry,
    capabilities,
    packagedHelp,
    capabilityExclusions: capabilityExcludedCommandKinds,
    syntheticCapabilities: daemonCapabilityOperations
  };
}

export function findCommandSurfaceParityViolations(surface = collectCommandSurfaceParity()) {
  const violations = [];
  const descriptorKinds = surface.descriptors.map((entry) => entry.kind);
  const registryKinds = surface.registry.map((entry) => entry.kind);
  const helpKinds = surface.packagedHelp.map((entry) => entry.kind);
  const capabilityKinds = surface.capabilities.map((entry) => entry.commandKind);
  const syntheticKinds = new Set(surface.syntheticCapabilities.map((entry) => entry.commandKind));
  const excludedKinds = new Set(surface.capabilityExclusions);

  rejectDuplicates("command descriptor", descriptorKinds, violations);
  rejectDuplicates("command registry", registryKinds, violations);
  rejectDuplicates("packaged help", helpKinds, violations);
  rejectDuplicates("capabilities", capabilityKinds, violations);

  compareKinds("descriptor", descriptorKinds, "registry", registryKinds, violations);
  compareKinds("descriptor", descriptorKinds, "packaged help", helpKinds, violations);

  const registered = new Set(registryKinds);
  const advertised = new Set(capabilityKinds);
  for (const kind of registryKinds) {
    if (!excludedKinds.has(kind) && !advertised.has(kind)) {
      violations.push(`registry command ${kind} is neither advertised by capabilities nor explicitly excluded`);
    }
  }
  for (const kind of capabilityKinds) {
    if (!registered.has(kind) && !syntheticKinds.has(kind)) {
      violations.push(`capabilities advertises unregistered command ${kind}`);
    }
  }
  for (const kind of syntheticKinds) {
    if (!advertised.has(kind)) violations.push(`synthetic capability ${kind} is absent from capabilities output`);
  }
  for (const kind of excludedKinds) {
    if (!registered.has(kind)) violations.push(`capability exclusion ${kind} is stale because the command is not registered`);
    if (advertised.has(kind)) violations.push(`capability exclusion ${kind} is advertised despite its exclusion`);
  }

  const registryByKind = new Map(surface.registry.map((entry) => [entry.kind, entry]));
  for (const help of surface.packagedHelp) {
    const registry = registryByKind.get(help.kind);
    if (!registry) continue;
    if (help.commandPath.join(" ") !== registry.commandPath.join(" ")) {
      violations.push(`packaged help path for ${help.kind} differs from registry`);
    }
    if (help.primary !== withoutGlobalJson(registry.primary)) {
      violations.push(`packaged help usage for ${help.kind} differs from registry`);
    }
  }
  for (const operation of surface.capabilities) {
    if (!registered.has(operation.commandKind) || syntheticKinds.has(operation.commandKind)) continue;
    if (operation.output?.receiptSchema !== "command-receipt/v2") {
      violations.push(`capabilities command ${operation.commandKind} advertises receipt schema ${String(operation.output?.receiptSchema)}`);
    }
  }
  return violations;
}

function compareKinds(leftLabel, leftKinds, rightLabel, rightKinds, violations) {
  const left = new Set(leftKinds);
  const right = new Set(rightKinds);
  for (const kind of left) if (!right.has(kind)) violations.push(`${leftLabel} command ${kind} is missing from ${rightLabel}`);
  for (const kind of right) if (!left.has(kind)) violations.push(`${rightLabel} command ${kind} is missing from ${leftLabel}`);
}

function rejectDuplicates(label, kinds, violations) {
  const seen = new Set();
  for (const kind of kinds) {
    if (seen.has(kind)) violations.push(`${label} contains duplicate command ${kind}`);
    seen.add(kind);
  }
}

function withoutGlobalJson(usage) {
  return usage.replace(/ \[--json\]/gu, "").replace(/ --json$/u, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = findCommandSurfaceParityViolations();
  if (violations.length > 0) {
    console.error("Command surface parity gate failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Command surface parity gate passed (${commandRegistry.length} registered commands).`);
  }
}
