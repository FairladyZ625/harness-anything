#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseProbeArgs } from "./probe-production-consumer.mjs";

const registrySchema = "harness-anything/staged-activation/v1";
const registryKeys = new Set(["schema", "schemaDocumentation", "islands"]);
const islandKeys = new Set(["id", "description", "probe", "anchor", "registeredAt", "expiresAt"]);
const probeKeys = new Set(["command", "args", "timeoutMs"]);
const maxProbeOutputBytes = 64 * 1024;
const runnerRepoRoot = path.resolve(import.meta.dirname, "..");

export function readStagedActivationRegistry(file) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read staged activation registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRegistry(registry);
  return registry;
}

export function validateRegistry(registry) {
  assertPlainObject(registry, "registry");
  assertExactKeys(registry, registryKeys, "registry");
  if (registry.schema !== registrySchema) throw new Error(`registry.schema must be ${registrySchema}`);
  if (registry.schemaDocumentation !== "tools/staged-activation.schema.md") {
    throw new Error("registry.schemaDocumentation must be tools/staged-activation.schema.md");
  }
  if (!Array.isArray(registry.islands)) throw new Error("registry.islands must be an array");

  const ids = new Set();
  for (const [index, island] of registry.islands.entries()) {
    const label = `registry.islands[${index}]`;
    assertPlainObject(island, label);
    assertExactKeys(island, islandKeys, label);
    if (typeof island.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(island.id)) {
      throw new Error(`${label}.id must be kebab-case`);
    }
    if (ids.has(island.id)) throw new Error(`duplicate island id: ${island.id}`);
    ids.add(island.id);
    if (typeof island.description !== "string" || island.description.trim() === "") {
      throw new Error(`${label}.description must be non-empty`);
    }
    if (typeof island.anchor !== "string" || !/^(?:task|milestone)_[A-Z0-9]+$/u.test(island.anchor)) {
      throw new Error(`${label}.anchor must be a task_* or milestone_* id`);
    }
    assertDate(island.registeredAt, `${label}.registeredAt`);
    if (island.expiresAt !== undefined) {
      assertDate(island.expiresAt, `${label}.expiresAt`);
      if (island.expiresAt < island.registeredAt) {
        throw new Error(`${label}.expiresAt cannot precede registeredAt`);
      }
    }
    validateProbe(island.probe, `${label}.probe`);
  }
}

function validateProbe(probe, label) {
  assertPlainObject(probe, label);
  assertExactKeys(probe, probeKeys, label);
  if (probe.command !== "node") throw new Error(`${label}.command must be node`);
  if (!Array.isArray(probe.args) || probe.args.length === 0
    || probe.args.some((arg) => typeof arg !== "string" || arg === "")) {
    throw new Error(`${label}.args must be a non-empty string array`);
  }
  if (probe.args[0] !== "tools/probe-production-consumer.mjs") {
    throw new Error(`${label}.args[0] must be tools/probe-production-consumer.mjs`);
  }
  if (probe.args.includes("--root")) throw new Error(`${label}.args cannot override --root`);
  if (!Number.isInteger(probe.timeoutMs) || probe.timeoutMs < 100 || probe.timeoutMs > 30000) {
    throw new Error(`${label}.timeoutMs must be an integer from 100 through 30000`);
  }
  parseProbeArgs(probe.args.slice(1));
}

export function runStagedActivation({ root, registry, today }) {
  const results = registry.islands.map((island) => runIslandProbe(root, island, today));
  const counts = {
    inactive: results.filter((result) => result.status === "inactive").length,
    activated: results.filter((result) => result.status === "activated").length,
    expired: results.filter((result) => result.status === "expired").length,
    errors: results.filter((result) => result.status === "error").length
  };
  const exitCode = counts.errors > 0 ? 2 : counts.activated > 0 || counts.expired > 0 ? 1 : 0;
  return { schema: "harness-anything/staged-activation-result/v1", today, counts, results, exitCode };
}

function runIslandProbe(root, island, today) {
  const probeScript = path.join(runnerRepoRoot, island.probe.args[0]);
  const result = spawnSync(process.execPath, [probeScript, ...island.probe.args.slice(1), "--root", root], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: maxProbeOutputBytes,
    shell: false,
    timeout: island.probe.timeoutMs
  });
  const stdout = trimOutput(result.stdout);
  const stderr = trimOutput(result.stderr);
  if (result.error || result.signal !== null || (result.status !== 0 && result.status !== 1)) {
    return {
      id: island.id,
      status: "error",
      detail: instrumentErrorDetail(result, stderr),
      stdout
    };
  }
  if (result.status === 0) {
    return { id: island.id, status: "activated", detail: stdout || "production consumer found" };
  }
  if (island.expiresAt !== undefined && today >= island.expiresAt) {
    return { id: island.id, status: "expired", detail: `inactive at expiry ${island.expiresAt}` };
  }
  return { id: island.id, status: "inactive", detail: "no qualifying production consumer" };
}

function instrumentErrorDetail(result, stderr) {
  if (result.error?.code === "ETIMEDOUT") return "probe timed out";
  if (result.error) return `probe spawn failed: ${result.error.message}`;
  if (result.signal !== null) return `probe terminated by signal ${result.signal}`;
  return `probe exited ${result.status}: ${stderr || "no diagnostic output"}`;
}

function trimOutput(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of allowed) {
    if (key !== "expiresAt" && !Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  }
}

function assertDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real UTC calendar date`);
  }
}

export function parseRunnerArgs(argv) {
  const options = { root: process.cwd(), registry: null, today: new Date().toISOString().slice(0, 10), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--root", "--registry", "--today"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--root") options.root = value;
      if (arg === "--registry") options.registry = value;
      if (arg === "--today") options.today = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  options.root = path.resolve(options.root);
  options.registry = options.registry === null
    ? path.join(options.root, "tools/staged-activation.json")
    : path.resolve(options.registry);
  assertDate(options.today, "--today");
  return options;
}

function printResult(result, json) {
  const { inactive, activated, expired, errors } = result.counts;
  console.log(
    `[staged-activation] ${inactive} 岛未激活 / ${activated} 岛已激活（应从登记表移除） / `
    + `${expired} 岛过期（红） / ${errors} 仪器错误`
  );
  for (const entry of result.results) {
    const output = entry.status === "error" ? console.error : console.log;
    output(`- ${entry.status.padEnd(9)} ${entry.id}: ${entry.detail}`);
  }
  if (json) console.log(JSON.stringify(result));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseRunnerArgs(process.argv.slice(2));
    const registry = readStagedActivationRegistry(options.registry);
    const result = runStagedActivation({ root: options.root, registry, today: options.today });
    printResult(result, options.json);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`[staged-activation] instrument error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
