#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mergifyPath = path.join(repoRoot, ".mergify.yml");
const gateManifestPath = path.join(repoRoot, "tools/gate-manifest.json");
const rewriteCiPath = path.join(repoRoot, ".github/workflows/rewrite-ci.yml");
const METADATA_EDIT_PREDICATE = "github.event_name == 'pull_request' && github.event.action == 'edited' && startsWith(github.event.pull_request.head.ref, 'mergify/merge-queue/')";
const METADATA_NOOP_PREFIX = "mergify-queue-metadata-edit-noop / ";

export function checkMergifyQueueContexts({
  mergifyText = readFileSync(mergifyPath, "utf8"),
  gateManifestText = readFileSync(gateManifestPath, "utf8")
} = {}) {
  const queueContexts = parseMergifyQueueCheckSuccessContexts(mergifyText);
  const requiredContexts = parseManifestBranchProtectionContexts(gateManifestText);
  const errors = [];
  const missing = requiredContexts.filter((context) => !queueContexts.includes(context));
  const extra = queueContexts.filter((context) => !requiredContexts.includes(context));

  if (requiredContexts.length === 0) {
    errors.push("gate manifest declares no branch-protection contexts");
  }
  if (queueContexts.length === 0) {
    errors.push(".mergify.yml queue_conditions declares no check-success contexts");
  }

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

export function checkRewriteCiMetadataContextRouting({
  workflowText = readFileSync(rewriteCiPath, "utf8"),
  gateManifestText = readFileSync(gateManifestPath, "utf8")
} = {}) {
  const manifest = JSON.parse(gateManifestText);
  const requiredContexts = parseManifestBranchProtectionContexts(gateManifestText);
  const requiredJobs = manifest.surfaces?.rewriteCi?.pullRequestGateJobs ?? [];
  const routes = parseRewriteCiMetadataContextRoutes(workflowText);
  const errors = [];
  const routedNormalContexts = [];
  const routedMetadataContexts = [];

  if (!/types:\s*\[[^\]]*\bedited\b[^\]]*\]/u.test(workflowText)) {
    errors.push("rewrite-ci must retain pull_request.edited for human PR body validation");
  }

  for (const job of requiredJobs) {
    const expectedContexts = requiredContexts.filter((context) => context === job || context.startsWith(`${job} (`));
    if (expectedContexts.length === 0) {
      errors.push(`required workflow job ${job} has no matching branch-protection context`);
      continue;
    }
    const route = routes.get(job);
    if (!route) {
      errors.push(`required workflow job ${job} has no metadata-edit context route`);
      continue;
    }
    if (route.predicate !== METADATA_EDIT_PREDICATE) {
      errors.push(`required workflow job ${job} uses an unexpected metadata-edit predicate`);
    }

    const normalContexts = expandRouteChoice(route.normal, route.matrix);
    const metadataContexts = expandRouteChoice(route.metadata, route.matrix);
    if (!sameStringSet(normalContexts, expectedContexts)) {
      errors.push(`${job} normal context route does not match required contexts: expected ${expectedContexts.join(", ")}, got ${normalContexts.join(", ")}`);
    }
    if (metadataContexts.some((context) => !context.startsWith(METADATA_NOOP_PREFIX))) {
      errors.push(`${job} metadata-edit contexts must use the ${METADATA_NOOP_PREFIX} namespace`);
    }
    if (metadataContexts.some((context) => requiredContexts.includes(context))) {
      errors.push(`${job} metadata-edit route republishes a required context`);
    }
    routedNormalContexts.push(...normalContexts);
    routedMetadataContexts.push(...metadataContexts);
  }

  if (!sameStringSet(routedNormalContexts, requiredContexts)) {
    errors.push("normal rewrite-ci context routes do not cover the exact branch-protection context set");
  }
  if (new Set(routedMetadataContexts).size !== routedMetadataContexts.length) {
    errors.push("metadata-edit no-op context names must be unique");
  }

  return {
    ok: errors.length === 0,
    errors,
    requiredContexts,
    normalContexts: routedNormalContexts,
    metadataContexts: routedMetadataContexts
  };
}

export function parseRewriteCiMetadataContextRoutes(workflowText) {
  const routes = new Map();
  const jobsText = workflowText.slice(workflowText.indexOf("\njobs:\n") + "\njobs:\n".length);
  const jobPattern = /^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/gmu;

  for (const match of jobsText.matchAll(jobPattern)) {
    const [, job, block] = match;
    const nameLine = /^\s{4}name:\s*\$\{\{\s*\((.+)\)\s*&&\s*(.+)\s*\|\|\s*(.+)\s*\}\}\s*$/mu.exec(block);
    if (!nameLine) {
      continue;
    }
    const matrix = new Map();
    for (const matrixMatch of block.matchAll(/^\s{8}([a-z][a-z0-9-]*):\s*\[([^\x5d]+)\]\s*$/gmu)) {
      matrix.set(matrixMatch[1], matrixMatch[2].split(",").map((value) => value.trim()));
    }
    routes.set(job, {
      predicate: nameLine[1].trim(),
      metadata: parseRouteChoice(nameLine[2].trim()),
      normal: parseRouteChoice(nameLine[3].trim()),
      matrix
    });
  }

  return routes;
}

export function simulateSameShaRequiredChecks({ requiredContexts, events }) {
  const latestByName = new Map();
  return events.map((event) => {
    for (const check of event) {
      latestByName.set(check.name, check.conclusion);
    }
    return Object.fromEntries(requiredContexts.map((context) => [
      context,
      latestByName.get(context) ?? "missing"
    ]));
  });
}

function parseRouteChoice(source) {
  const literal = /^'([^']+)'$/u.exec(source);
  if (literal) {
    return { template: literal[1], matrixKey: null };
  }
  const formatted = /^format\('([^']+)',\s*matrix\.([a-z][a-z0-9-]*)\)$/u.exec(source);
  if (formatted) {
    return { template: formatted[1], matrixKey: formatted[2] };
  }
  return { template: `__invalid_route_choice__${source}`, matrixKey: null };
}

function expandRouteChoice(choice, matrix) {
  if (choice.matrixKey === null) {
    return [choice.template];
  }
  const values = matrix.get(choice.matrixKey) ?? [];
  return values.map((value) => choice.template.replaceAll("{0}", value));
}

function sameStringSet(left, right) {
  return left.length === right.length
    && left.every((value) => right.includes(value))
    && right.every((value) => left.includes(value));
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
  const queueResult = checkMergifyQueueContexts();
  const routingResult = checkRewriteCiMetadataContextRouting();
  const errors = [...queueResult.errors, ...routingResult.errors];
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Mergify queue context check passed (${queueResult.queueContexts.length} stable required contexts).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
