#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assignIntegrationTestShards,
  defaultIntegrationTestWeightMs,
  integrationShardCount,
  integrationTestFileWeightsMs
} from "./integration-test-shards.mjs";
import {
  integrationTestFilesFingerprint,
  packageLockFingerprint,
  validateIntegrationTestTimingReport
} from "./integration-test-timing.mjs";
import { discoverTestTierManifest } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const weightSourcePath = path.join(repoRoot, "tools/integration-test-shards.mjs");
const generatedWeightStart = "// BEGIN GENERATED INTEGRATION TEST WEIGHTS";
const generatedWeightEnd = "// END GENERATED INTEGRATION TEST WEIGHTS";

export function aggregateIntegrationTestTimings(reports, {
  manifestFiles,
  currentWeights = integrationTestFileWeightsMs,
  shardCount = integrationShardCount,
  defaultWeightMs = defaultIntegrationTestWeightMs,
  packageLockSha256,
  nodeMajor
}) {
  const expectedShardIds = Array.from({ length: shardCount }, (_, index) => index + 1);
  const actualShardIds = reports.map((report) => report?.shard?.id).sort((left, right) => left - right);
  if (!sameList(actualShardIds, expectedShardIds)) {
    throw new Error(`expected timing shards [${expectedShardIds.join(", ")}], got [${actualShardIds.join(", ")}]`);
  }

  const manifestFingerprint = integrationTestFilesFingerprint(manifestFiles);
  const identity = reportIdentity(reports[0]);
  const durations = new Map();
  for (const report of reports) {
    const validation = validateIntegrationTestTimingReport(report);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    if (report.shard.count !== shardCount) {
      throw new Error(`timing shard count mismatch: expected ${shardCount}, got ${report.shard.count}`);
    }
    if (reportIdentity(report) !== identity) {
      throw new Error("timing artifacts must come from the same successful run");
    }
    if (report.runtime.testFilesSha256 !== manifestFingerprint) {
      throw new Error("timing artifact test file set does not match the current integration manifest");
    }
    if (packageLockSha256 !== undefined && report.runtime.packageLockSha256 !== packageLockSha256) {
      throw new Error("timing artifact package-lock fingerprint does not match the current checkout");
    }
    if (nodeMajor !== undefined && Number.parseInt(report.runtime.nodeVersion.replace(/^v/u, "").split(".")[0], 10) !== nodeMajor) {
      throw new Error("timing artifact Node major does not match the current aggregation runtime");
    }
    for (const file of report.files) {
      if (durations.has(file.path)) throw new Error(`duplicate timing file: ${file.path}`);
      durations.set(file.path, file.durationMs);
    }
  }

  const measuredFiles = [...durations.keys()].sort();
  const expectedFiles = [...manifestFiles].sort();
  if (!sameList(measuredFiles, expectedFiles)) {
    throw new Error("timing artifact test file set does not match the current integration manifest");
  }

  const weightsMs = Object.fromEntries(measuredFiles.map((file) => [
    file,
    Math.round(durations.get(file) * 100) / 100
  ]));
  const beforePlan = assignIntegrationTestShards(manifestFiles, currentWeights, shardCount, defaultWeightMs);
  const afterPlan = assignIntegrationTestShards(manifestFiles, weightsMs, shardCount, defaultWeightMs);
  const first = reports[0];
  return {
    schema: "harness-integration-test-weight-proposal/v1",
    purpose: "human-reviewed-scheduling-update",
    source: { ...first.source },
    runtime: { ...first.runtime },
    fileCount: measuredFiles.length,
    balance: {
      before: summarizePlan(beforePlan, weightsMs, defaultWeightMs),
      after: summarizePlan(afterPlan, weightsMs, defaultWeightMs)
    },
    weightsMs
  };
}

export function applyIntegrationTestWeightProposal(source, weightsMs) {
  const start = source.indexOf(generatedWeightStart);
  const end = source.indexOf(generatedWeightEnd);
  if (start < 0 || end < start) {
    throw new Error("integration weight source is missing generated block markers");
  }
  const replacement = renderIntegrationTestWeights(weightsMs);
  return `${source.slice(0, start)}${replacement}${source.slice(end + generatedWeightEnd.length)}`;
}

export function renderIntegrationTestWeights(weightsMs) {
  const entries = Object.entries(weightsMs).sort(([left], [right]) => left.localeCompare(right));
  return [
    generatedWeightStart,
    "export const integrationTestFileWeightsMs = Object.freeze({",
    ...entries.map(([file, weight], index) => `  ${JSON.stringify(file)}: ${formatWeight(weight)}${index === entries.length - 1 ? "" : ","}`),
    "});",
    generatedWeightEnd
  ].join("\n");
}

export function loadIntegrationTimingReports(timingRoot) {
  if (!existsSync(timingRoot)) throw new Error(`timing root does not exist: ${timingRoot}`);
  return collectJsonFiles(timingRoot)
    .map((file) => JSON.parse(readFileSync(file, "utf8")));
}

function summarizePlan(shards, weights, defaultWeightMs) {
  const shardWorkMs = shards.map((shard) => shard.files.reduce(
    (total, file) => total + (weights[file] ?? defaultWeightMs),
    0
  ));
  const averageMs = shardWorkMs.reduce((total, duration) => total + duration, 0) / shardWorkMs.length;
  const maxMs = Math.max(...shardWorkMs);
  return { shardWorkMs, averageMs, maxMs, maxOverAverage: maxMs / averageMs };
}

function reportIdentity(report) {
  return JSON.stringify({ source: report?.source, runtime: report?.runtime });
}

function collectJsonFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(entryPath);
  }
  return files;
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatWeight(value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid integration test weight: ${value}`);
  return Number.isInteger(value) ? String(value) : String(value);
}

function parseArgs(args) {
  const options = { timingRoot: undefined, write: false, summaryOutput: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timing-root" || arg === "--summary-output") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      options[arg === "--timing-root" ? "timingRoot" : "summaryOutput"] = value;
      index += 1;
      continue;
    }
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    throw new Error(`unknown aggregate-integration-test-timings option: ${arg}`);
  }
  if (options.timingRoot === undefined) throw new Error("--timing-root is required");
  return options;
}

function main(args) {
  const options = parseArgs(args);
  const manifest = discoverTestTierManifest(repoRoot);
  const proposal = aggregateIntegrationTestTimings(
    loadIntegrationTimingReports(path.resolve(repoRoot, options.timingRoot)),
    {
      manifestFiles: manifest.integration,
      packageLockSha256: packageLockFingerprint(repoRoot),
      nodeMajor: Number.parseInt(process.versions.node.split(".")[0], 10)
    }
  );
  if (options.write) {
    const source = readFileSync(weightSourcePath, "utf8");
    writeFileSync(weightSourcePath, applyIntegrationTestWeightProposal(source, proposal.weightsMs), "utf8");
  }
  if (options.summaryOutput !== undefined) {
    const output = path.resolve(repoRoot, options.summaryOutput);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  }
  console.log(
    `integration timing proposal: files=${proposal.fileCount} ` +
    `max/avg=${proposal.balance.before.maxOverAverage.toFixed(3)} -> ${proposal.balance.after.maxOverAverage.toFixed(3)} ` +
    `write=${options.write}`
  );
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
