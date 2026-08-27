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
import { readTestQuarantine } from "./test-quarantine.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "tools/gate-manifest.json");

export function parseManifestGateArgs(args) {
  const options = {
    packageSurface: null,
    workflowJob: null,
    shard: null,
    exclude: new Set(),
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
    .filter((gate) =>
      [
        ...(gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? []),
        ...(gate.executionSurfaces?.rewriteCi?.nonPullRequestJobs ?? []),
      ].includes(options.workflowJob),
    )
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
    // The runner has to start before it can report anything, so a hardcoded POSIX shell made
    // every Windows lane fail at "spawnSync /bin/sh ENOENT" with no gate output at all.
    shell: true,
    stdio: "inherit",
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${label} failed to launch: ${result.error.message}`);
    return { ok: false, durationMs: Date.now() - started };
  }
  if (result.status !== 0) {
    console.error(`✖ ${label} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    return { ok: false, durationMs: Date.now() - started };
  }
  console.log(`✓ ${label} (${elapsedS}s)`);
  return { ok: true, durationMs: Date.now() - started };
}

function main(argv) {
  const options = parseManifestGateArgs(argv);
  readTestQuarantine(repoRoot);
  if (shouldSkipTestQuarantine(options.workflowJob, process.env)) process.env.HARNESS_TEST_QUARANTINE = "skip";
  if (options.workflowJob)
    process.env.HARNESS_CI_JOB ||=
      options.shard === null ? options.workflowJob : `${options.workflowJob} (${options.shard})`;
  if (options.shard !== null) process.env.HARNESS_TEST_SHARD = String(options.shard);
  if (options.workflowJob === "integration-shard" || options.workflowJob === "windows-integration-shard")
    process.env.HARNESS_TEST_TIER = "integration";
  else if (options.workflowJob === "gui-build") process.env.HARNESS_TEST_TIER = "gui";
  else if (options.workflowJob) process.env.HARNESS_TEST_TIER ||= "contract";
  if (process.env.GITHUB_ACTIONS === "true") {
    process.env.HARNESS_CI_JOB_STARTED_MS ||= String(Date.now());
    process.env.HARNESS_CI_NODE_TEST_RESULTS ||= path.join(repoRoot, "tmp/ci-observation/node-tests.json");
    process.env.HARNESS_CI_VITEST_RESULTS ||= path.join(repoRoot, "tmp/ci-observation/vitest.json");
    process.env.HARNESS_CI_GATE_RESULTS ||= path.join(repoRoot, "tmp/ci-observation/gates.json");
    process.env.HARNESS_CI_OBSERVATION_OUTPUT ||= path.join(repoRoot, "tmp/ci-observation/observation.json");
    process.env.HARNESS_CI_JOB ||= process.env.GITHUB_JOB ?? "unknown";
    process.env.HARNESS_PR_NUMBER ||=
      process.env.GITHUB_EVENT_NAME === "pull_request" ? extractPullRequestNumber() : "";
  }
  const manifest = readManifest();
  const plan = buildManifestGatePlan(manifest, options);
  const selector = options.packageSurface ? `package:${options.packageSurface}` : `workflow:${options.workflowJob}`;

  console.log(`Manifest gate runner (${selector}): ${plan.length} command(s).`);
  const gateResults = [];
  for (const entry of plan) {
    const result = runCommand(entry.id, entry.command);
    gateResults.push({ gate: canonicalGateId(entry.id), pass: result.ok, metrics: { durationMs: result.durationMs } });
    if (!result.ok) {
      writeObservation(gateResults);
      process.exitCode = 1;
      return;
    }
  }
  writeObservation(gateResults);
  console.log(`\nManifest gate runner passed (${selector}).`);
}

function canonicalGateId(id) {
  return { "line-budget": "G32", "production-delta": "G33", "entity-id-links": "G37" }[id] ?? id;
}

function writeObservation(gateResults) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const gatePath = process.env.HARNESS_CI_GATE_RESULTS;
  if (!gatePath) return;
  spawnSync(
    process.execPath,
    [
      "-e",
      "const fs=require('fs'),p=process.argv[1];fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(JSON.parse(process.argv[2]))+'\\n')",
      gatePath,
      JSON.stringify(gateResults),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  spawnSync(process.execPath, [path.join(repoRoot, "tools/write-ci-observation.mjs")], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
}

function extractPullRequestNumber() {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    return String(event.pull_request?.number ?? "");
  } catch {
    return "";
  }
}

const l0WorkflowJobs = new Set([
  "pr-body-lint",
  "typecheck",
  "fast-contract",
  "integration-shard",
  "boundaries",
  "package-policy",
  "supply-chain",
  "gui-build",
  "node26-compatibility",
]);

export function shouldSkipTestQuarantine(workflowJob, env) {
  return Boolean(
    workflowJob &&
      l0WorkflowJobs.has(workflowJob) &&
      env.GITHUB_EVENT_NAME === "pull_request" &&
      !String(env.GITHUB_HEAD_REF ?? "").startsWith("mergify/merge-queue/"),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Manifest gate runner failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
