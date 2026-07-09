#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mergifyPath = path.join(repoRoot, ".mergify.yml");
const gateManifestPath = path.join(repoRoot, "tools/gate-manifest.json");

export function checkMergifyQueueContexts({
  mergifyText = readFileSync(mergifyPath, "utf8"),
  gateManifestText = readFileSync(gateManifestPath, "utf8")
} = {}) {
  const queueContexts = parseMergifyQueueCheckSuccessContexts(mergifyText);
  const requiredContexts = parseManifestBranchProtectionContexts(gateManifestText);
  const missing = requiredContexts.filter((context) => !queueContexts.includes(context));
  const extra = queueContexts.filter((context) => !requiredContexts.includes(context));
  const errors = [];

  if (missing.length > 0) {
    errors.push(`missing required contexts in .mergify.yml queue_conditions: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(`extra queue contexts not declared by gate manifest: ${extra.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    queueContexts,
    requiredContexts
  };
}

export function parseMergifyQueueCheckSuccessContexts(mergifyText) {
  const contexts = [];
  const seen = new Set();
  const lines = mergifyText.split(/\r?\n/u);
  let inQueueConditions = false;
  let queueConditionsIndent = 0;

  for (const line of lines) {
    const queueMatch = /^(\s*)queue_conditions:\s*$/u.exec(line);
    if (queueMatch) {
      inQueueConditions = true;
      queueConditionsIndent = queueMatch[1].length;
      continue;
    }

    if (!inQueueConditions) {
      continue;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const lineIndent = line.search(/\S/u);
    if (lineIndent <= queueConditionsIndent) {
      inQueueConditions = false;
      continue;
    }

    const conditionMatch = /^\s*-\s*check-success\s*=\s*(.+?)\s*$/u.exec(line);
    if (!conditionMatch) {
      continue;
    }
    const context = unquoteYamlScalar(conditionMatch[1].trim());
    if (!seen.has(context)) {
      seen.add(context);
      contexts.push(context);
    }
  }

  return contexts;
}

export function parseManifestBranchProtectionContexts(gateManifestText) {
  const manifest = JSON.parse(gateManifestText);
  const contexts = [];
  const seen = new Set();

  for (const gate of manifest.gates ?? []) {
    for (const context of gate.executionSurfaces?.branchProtection?.contexts ?? []) {
      if (!seen.has(context)) {
        seen.add(context);
        contexts.push(context);
      }
    }
  }

  return contexts;
}

function unquoteYamlScalar(value) {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\"/gu, "\"");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

function main() {
  const result = checkMergifyQueueContexts();
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Mergify queue context check passed (${result.queueContexts.length} contexts).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
