#!/usr/bin/env node
/**
 * Executes gate commands from tools/gate-manifest.json.
 *
 * This runner keeps aggregate check chains and CI job gate steps derived from
 * the manifest so adding a gate changes the manifest entry, not every consumer
 * surface. It intentionally executes commands sequentially and stops at the
 * first failure to preserve the old `&&` chain behavior.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "tools/gate-manifest.json");

export function parseManifestGateArgs(args) {
  const options = {
    packageSurface: null,
    workflowJob: null,
    shard: null,
    exclude: new Set()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--package-surface") {
      options.packageSurface = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--workflow-job") {
      options.workflowJob = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--shard") {
      options.shard = parsePositiveInteger(requireValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--exclude") {
      for (const id of requireValue(args, index, arg).split(",")) {
        const trimmed = id.trim();
        if (trimmed) {
          options.exclude.add(trimmed);
        }
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown run-manifest-gates option: ${arg}`);
  }

  const selectorCount = Number(Boolean(options.packageSurface)) + Number(Boolean(options.workflowJob));
  if (selectorCount !== 1) {
    throw new Error("exactly one of --package-surface or --workflow-job is required");
  }

  if (options.packageSurface !== null && !["check", "checkPr"].includes(options.packageSurface)) {
    throw new Error("--package-surface must be check or checkPr");
  }

  return options;
}

export function selectManifestGateIds(manifest, options) {
  if (options.packageSurface) {
    const ids = manifest.surfaces?.packageJson?.[options.packageSurface];
    if (!Array.isArray(ids)) {
      throw new Error(`manifest has no packageJson surface ${options.packageSurface}`);
    }
    return ids.filter((id) => !options.exclude.has(id));
  }

  return manifest.gates
    .filter((gate) => !gate.aggregate)
    .filter((gate) => gate.executionSurfaces?.rewriteCi?.pullRequestJobs?.includes(options.workflowJob))
    .map((gate) => gate.id)
    .filter((id) => !options.exclude.has(id));
}

export function buildManifestGatePlan(manifest, options) {
  const gateIds = selectManifestGateIds(manifest, options);
  const gatesById = new Map(manifest.gates.map((gate) => [gate.id, gate]));
  const gates = gateIds.map((id) => {
    const gate = gatesById.get(id);
    if (!gate) {
      throw new Error(`manifest surface references unknown gate id ${id}`);
    }
    if (!gate.command || typeof gate.command !== "string") {
      throw new Error(`manifest gate ${id} has no executable command`);
    }
    return gate;
  });

  return collapseCompositeCoveredCommands(dedupeCommands(applyShardOption(gates, options.shard)));
}

function dedupeCommands(gates) {
  const seen = new Set();
  const commands = [];
  for (const gate of gates) {
    if (seen.has(gate.command)) {
      continue;
    }
    seen.add(gate.command);
    commands.push({ id: gate.id, command: gate.command });
  }
  return commands;
}

function applyShardOption(gates, shard) {
  if (shard === null || shard === undefined) {
    return gates.map((gate) => ({ ...gate }));
  }

  return gates.map((gate) => {
    if (gate.shardable !== true) {
      throw new Error(`manifest gate ${gate.id} is not shardable but --shard was provided`);
    }
    return { ...gate, command: `${gate.command} -- --shard ${shard}` };
  });
}

function collapseCompositeCoveredCommands(commands) {
  const commandSet = new Set(commands.map((entry) => entry.command));
  const coveredParts = new Set();

  for (const entry of commands) {
    const parts = splitShellAndList(entry.command);
    if (parts.length <= 1 || !parts.every((part) => commandSet.has(part))) {
      continue;
    }
    for (const part of parts) {
      coveredParts.add(part);
    }
  }

  return commands.filter((entry) => !coveredParts.has(entry.command));
}

export function splitShellAndList(command) {
  return command
    .split(/\s+&&\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function runCommand(label, command) {
  console.log(`\n▶ ${label}  (${command})`);
  const started = Date.now();
  const result = spawnSync(command, {
    cwd: repoRoot,
    env: process.env,
    shell: "/bin/sh",
    stdio: "inherit"
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${label} failed to launch: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`✖ ${label} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    return false;
  }
  console.log(`✓ ${label} (${elapsedS}s)`);
  return true;
}

function main(argv) {
  const options = parseManifestGateArgs(argv);
  const manifest = readManifest();
  const plan = buildManifestGatePlan(manifest, options);
  const selector = options.packageSurface ? `package:${options.packageSurface}` : `workflow:${options.workflowJob}`;

  console.log(`Manifest gate runner (${selector}): ${plan.length} command(s).`);
  for (const entry of plan) {
    if (!runCommand(entry.id, entry.command)) {
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nManifest gate runner passed (${selector}).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Manifest gate runner failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
