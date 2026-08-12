import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./git.mjs";

const CONTRACT_FILE = /\.contract\.(?:mjs|ts)$/u;
const IGNORED_DIRECTORIES = new Set([".git", "coverage", "dist", "node_modules"]);
const DOMAINS = Object.freeze(["commands", "gates", "guards", "methods"]);

function repoPath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function walk(directory, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile() && CONTRACT_FILE.test(entry.name)) files.push(fullPath);
  }
}

export function discoverContractFiles(rootDir) {
  const files = [];
  for (const root of ["packages", "src", "tools"]) walk(path.join(rootDir, root), files);
  return files.sort().map((file) => repoPath(rootDir, file));
}

export async function loadContracts(rootDir, files = discoverContractFiles(rootDir)) {
  const contracts = [];
  for (const file of files) {
    const absolutePath = path.join(rootDir, file);
    const module = await import(`${pathToFileURL(absolutePath).href}?contract=${encodeURIComponent(String(readFileSync(absolutePath).length))}`);
    contracts.push({ file, declaration: module.default ?? module.contract });
  }
  return contracts;
}

function entryId(entry) {
  return typeof entry === "string" ? entry : entry?.id;
}

export function assertPhaseAppendOnly(previous, current, source = "contract") {
  if (!Array.isArray(previous) || !Array.isArray(current)) return [`${source}: phases must be arrays`];
  if (current.length < previous.length || previous.some((phase, index) => current[index] !== phase)) {
    return [`${source}: phases are append-only; expected prefix ${JSON.stringify(previous)}, got ${JSON.stringify(current)}`];
  }
  return [];
}

function previousPhases(rootDir, file) {
  const result = spawnSync("git", ["show", `HEAD^:${file}`], { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = /\bphases\s*:\s*(\[[^\]]*\])/u.exec(result.stdout);
  if (match === null) return null;
  return JSON.parse(match[1]);
}

function workflowJobs(source) {
  const lines = source.split(/\r?\n/u);
  const jobs = new Map();
  let current = null;
  let body = [];
  let inJobs = false;
  for (const line of lines) {
    if (line === "jobs:") {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const match = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (match !== null) {
      if (current !== null) jobs.set(current, body.join("\n"));
      current = match[1];
      body = [];
    } else if (current !== null) {
      body.push(line);
    }
  }
  if (current !== null) jobs.set(current, body.join("\n"));
  return jobs;
}

function validateWorkflowProjection(rootDir, contract, errors) {
  const workflow = contract.declaration?.projection?.workflow;
  if (workflow === undefined) return;
  if (typeof workflow !== "string" || workflow.length === 0) {
    errors.push(`${contract.file}: projection.workflow must be a repository path`);
    return;
  }
  const workflowPath = path.join(rootDir, workflow);
  if (!existsSync(workflowPath)) {
    errors.push(`${contract.file}: workflow projection not found: ${workflow}`);
    return;
  }
  const jobs = workflowJobs(readFileSync(workflowPath, "utf8"));
  const declaredJobs = new Set((contract.declaration.gates ?? []).map((gate) => gate.job));
  for (const job of jobs.keys()) {
    if (!declaredJobs.has(job)) errors.push(`${workflow}: workflow job is not declared by ${contract.file}: ${job}`);
  }
  for (const job of declaredJobs) {
    if (!jobs.has(job)) errors.push(`${workflow}: declared gate job is missing: ${job}`);
  }
  for (const gate of contract.declaration.gates ?? []) {
    if (typeof gate.command !== "string" || gate.command.length === 0) {
      errors.push(`${contract.file}: gate ${gate.id} must declare its projection command`);
    } else if (jobs.has(gate.job) && !jobs.get(gate.job).includes(gate.command)) {
      errors.push(`${workflow}: ${gate.job} does not project command for ${gate.id}: ${gate.command}`);
    }
  }
}

function validateCatalogProjection(rootDir, contract, errors) {
  const catalog = contract.declaration?.projection?.catalog;
  if (catalog === undefined) return;
  if (typeof catalog !== "string" || catalog.length === 0 || !existsSync(path.join(rootDir, catalog))) {
    errors.push(`${contract.file}: catalog projection not found: ${catalog}`);
    return;
  }
  const actual = JSON.parse(readFileSync(path.join(rootDir, catalog), "utf8"));
  const expected = {
    contractId: contract.declaration.id,
    commands: (contract.declaration.commands ?? []).map(entryId),
    gates: (contract.declaration.gates ?? []).map(entryId),
    guards: (contract.declaration.guards ?? []).map(entryId),
    phases: contract.declaration.phases ?? []
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${catalog}: catalog projection differs from ${contract.file}`);
}

export function validateDerivedContracts(rootDir, contracts) {
  const errors = [];
  const seen = new Map();
  for (const contract of contracts) {
    const declaration = contract.declaration;
    if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
      errors.push(`${contract.file}: default export must be a contract object`);
      continue;
    }
    if (typeof declaration.id !== "string" || declaration.id.length === 0) errors.push(`${contract.file}: contract id is required`);
    if (!Array.isArray(declaration.phases) || declaration.phases.length === 0) errors.push(`${contract.file}: phases must be a non-empty array`);
    else {
      const uniquePhases = new Set(declaration.phases);
      if (uniquePhases.size !== declaration.phases.length) errors.push(`${contract.file}: phases contain duplicates`);
      const previous = previousPhases(rootDir, contract.file);
      if (previous !== null) errors.push(...assertPhaseAppendOnly(previous, declaration.phases, contract.file));
    }
    for (const domain of DOMAINS) {
      const entries = declaration[domain] ?? [];
      if (!Array.isArray(entries)) {
        errors.push(`${contract.file}: ${domain} must be an array`);
        continue;
      }
      for (const entry of entries) {
        const id = entryId(entry);
        if (typeof id !== "string" || id.length === 0) {
          errors.push(`${contract.file}: ${domain} entry id is required`);
          continue;
        }
        const key = `${domain}:${id}`;
        if (seen.has(key)) errors.push(`${contract.file}: duplicate ${domain} id ${id}; first declared in ${seen.get(key)}`);
        else seen.set(key, contract.file);
        if (typeof entry === "object" && entry !== null && !declaration.phases.includes(entry.phase)) {
          errors.push(`${contract.file}: ${domain} ${id} uses undeclared phase ${entry.phase}`);
        }
      }
    }
    validateWorkflowProjection(rootDir, contract, errors);
    validateCatalogProjection(rootDir, contract, errors);
  }
  return errors;
}

export async function checkDerivedContracts(rootDir) {
  const files = discoverContractFiles(rootDir);
  if (files.length === 0) return ["no *.contract.ts or *.contract.mjs declarations found"];
  return validateDerivedContracts(rootDir, await loadContracts(rootDir, files));
}

async function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/derived-contracts.mjs --check");
  const rootDir = repoRoot();
  const errors = await checkDerivedContracts(rootDir);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`derived-contracts: ok (${discoverContractFiles(rootDir).length} declarations)`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
