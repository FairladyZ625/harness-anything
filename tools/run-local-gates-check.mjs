#!/usr/bin/env node
/**
 * Required local runner for measured sub-second static manifest gates.
 *
 * The default `check:local` fast tier stays intentionally small. This runner
 * derives the extra static checker surface from tools/gate-manifest.json and
 * package.json so local preflight can cover required checker gates without
 * copying a second checklist into package scripts.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "tools/gate-manifest.json");
const packageJsonPath = path.join(repoRoot, "package.json");

const npmHarnessScriptPattern = /^npm run (harness:[^\s&|;]+)$/u;
const staticCheckerCommandPattern = /^node tools\/(?:check|scan)-[^&|;]+\.mjs(?:\s|$)/u;
// These entries are manifest-vetted sub-second scans, never tests or builds.
// A bounded batch keeps their combined wall time below the local-stop budget.
const STATIC_GATE_CONCURRENCY = 8;

export function selectLocalGateChecks(manifest, packageScripts) {
  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
  const gateIds = manifest.surfaces?.localStop?.gateIds;
  if (!Array.isArray(gateIds) || gateIds.length === 0) {
    throw new Error("manifest surfaces.localStop.gateIds must declare at least one gate");
  }
  if (new Set(gateIds).size !== gateIds.length) {
    throw new Error("manifest surfaces.localStop.gateIds contains duplicates");
  }
  const gatesById = new Map(gates.map((gate) => [gate.id, gate]));
  const selected = [];
  const seenCommands = new Set();

  for (const gateId of gateIds) {
    const gate = gatesById.get(gateId);
    if (gate === undefined) throw new Error(`local stop surface references unknown gate ${gateId}`);
    if (gate.aggregate || gate.tier !== "pr-required" || gate.category === "smoke") {
      throw new Error(`local stop gate ${gate.id} must be a non-smoke PR-required leaf gate`);
    }
    const jobs = gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? [];
    if (jobs.length === 0) throw new Error(`local stop gate ${gate.id} has no pull-request workflow job`);

    const scriptName = parseHarnessScriptName(gate.command);
    if (scriptName === null) {
      throw new Error(`local stop gate ${gate.id} is not a static checker command: ${gate.command}`);
    }
    const scriptCommand = packageScripts[scriptName];
    if (typeof scriptCommand !== "string") {
      throw new Error(`manifest gate ${gate.id} references missing package script ${scriptName}`);
    }
    if (!staticCheckerCommandPattern.test(scriptCommand)) {
      throw new Error(`local stop gate ${gate.id} is not a static checker command: ${scriptCommand}`);
    }
    if (seenCommands.has(gate.command)) {
      continue;
    }

    seenCommands.add(gate.command);
    selected.push({
      id: gate.id,
      command: gate.command,
      scriptName,
      scriptCommand,
      workflowJobs: jobs
    });
  }

  if (selected.length === 0) {
    throw new Error("manifest yielded no PR-required static checker gates");
  }
  return selected;
}

function parseHarnessScriptName(command) {
  const match = npmHarnessScriptPattern.exec(command);
  return match?.[1] ?? null;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runCommand(entry) {
  const started = Date.now();
  const child = spawn(entry.scriptCommand, {
    cwd: repoRoot,
    env: process.env,
    shell: "/bin/sh",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ ok: false, error, stdout, stderr, elapsedS: elapsed(started) }));
    child.once("close", (code, signal) => resolve({
      ok: signal === null && code === 0,
      code,
      signal,
      stdout,
      stderr,
      elapsedS: elapsed(started)
    }));
  });
}

async function runPlan(plan) {
  for (let offset = 0; offset < plan.length; offset += STATIC_GATE_CONCURRENCY) {
    const batch = plan.slice(offset, offset + STATIC_GATE_CONCURRENCY);
    const outcomes = await Promise.all(batch.map(async (entry) => ({ entry, outcome: await runCommand(entry) })));
    for (const { entry, outcome } of outcomes) {
      console.log(`\n▶ ${entry.id}  (${entry.scriptCommand})`);
      if (outcome.stdout) process.stdout.write(outcome.stdout);
      if (outcome.stderr) process.stderr.write(outcome.stderr);
      if (outcome.ok) {
        console.log(`✓ ${entry.id} (${outcome.elapsedS}s)`);
      } else if (outcome.error) {
        console.error(`✖ ${entry.id} failed to launch: ${outcome.error.message}`);
      } else {
        console.error(`✖ ${entry.id} failed (exit ${outcome.code ?? outcome.signal ?? "signal"}) after ${outcome.elapsedS}s`);
      }
    }
    const failed = outcomes.find(({ outcome }) => !outcome.ok);
    if (failed) return failed.entry.id;
  }
  return null;
}

function elapsed(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

function printPlan(plan) {
  console.log(`Local stop-point static gates: ${plan.length} checker(s), derived from gate-manifest.`);
  for (const entry of plan) {
    console.log(`- ${entry.id}: ${entry.command} -> ${entry.scriptCommand} [${entry.workflowJobs.join(",")}]`);
  }
}

function parseArgs(args) {
  const options = { list: false };
  for (const arg of args) {
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    throw new Error(`unknown run-local-gates-check option: ${arg}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const manifest = readJson(manifestPath);
  const packageJson = readJson(packageJsonPath);
  const plan = selectLocalGateChecks(manifest, packageJson.scripts ?? {});
  printPlan(plan);

  if (options.list) {
    return;
  }

  const totalStart = Date.now();
  const failedGate = await runPlan(plan);
  if (failedGate !== null) {
    console.error(`\nLocal manifest static gate check stopped at: ${failedGate}.`);
    process.exitCode = 1;
    return;
  }
  const totalS = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\nLocal manifest static gate check passed in ${totalS}s.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Local manifest static gate check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
