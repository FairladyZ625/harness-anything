#!/usr/bin/env node
/**
 * Optional local runner for PR-required static manifest gates.
 *
 * The default `check:local` fast tier stays intentionally small. This runner
 * derives the extra static checker surface from tools/gate-manifest.json and
 * package.json so local preflight can cover required checker gates without
 * copying a second checklist into package scripts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "tools/gate-manifest.json");
const packageJsonPath = path.join(repoRoot, "package.json");

const npmHarnessScriptPattern = /^npm run (harness:[^\s&|;]+)$/u;
const staticCheckerCommandPattern = /^node tools\/(?:check|scan)-[^&|;]+\.mjs(?:\s|$)/u;

export function selectLocalGateChecks(manifest, packageScripts) {
  const pullRequestGateJobs = new Set(manifest.surfaces?.rewriteCi?.pullRequestGateJobs ?? []);
  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
  const selected = [];
  const seenCommands = new Set();

  for (const gate of gates) {
    if (gate.aggregate || gate.tier !== "pr-required" || gate.category === "smoke") {
      continue;
    }
    const jobs = gate.executionSurfaces?.rewriteCi?.pullRequestJobs ?? [];
    if (!jobs.some((job) => pullRequestGateJobs.has(job))) {
      continue;
    }

    const scriptName = parseHarnessScriptName(gate.command);
    if (scriptName === null) {
      continue;
    }
    const scriptCommand = packageScripts[scriptName];
    if (typeof scriptCommand !== "string") {
      throw new Error(`manifest gate ${gate.id} references missing package script ${scriptName}`);
    }
    if (!staticCheckerCommandPattern.test(scriptCommand)) {
      continue;
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
  console.log(`\n▶ ${entry.id}  (${entry.command})`);
  const started = Date.now();
  const result = spawnSync(entry.command, {
    cwd: repoRoot,
    env: process.env,
    shell: "/bin/sh",
    stdio: "inherit"
  });
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`✖ ${entry.id} failed to launch: ${result.error.message}`);
    return { ok: false, elapsedS };
  }
  if (result.status !== 0) {
    console.error(`✖ ${entry.id} failed (exit ${result.status ?? "signal"}) after ${elapsedS}s`);
    return { ok: false, elapsedS };
  }
  console.log(`✓ ${entry.id} (${elapsedS}s)`);
  return { ok: true, elapsedS };
}

function printPlan(plan) {
  console.log(`Local manifest static gate check: ${plan.length} checker(s).`);
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

function main(argv) {
  const options = parseArgs(argv);
  const manifest = readJson(manifestPath);
  const packageJson = readJson(packageJsonPath);
  const plan = selectLocalGateChecks(manifest, packageJson.scripts ?? {});
  printPlan(plan);

  if (options.list) {
    return;
  }

  const totalStart = Date.now();
  for (const entry of plan) {
    const outcome = runCommand(entry);
    if (!outcome.ok) {
      console.error(`\nLocal manifest static gate check stopped at: ${entry.id}.`);
      process.exitCode = 1;
      return;
    }
  }
  const totalS = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\nLocal manifest static gate check passed in ${totalS}s.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Local manifest static gate check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
