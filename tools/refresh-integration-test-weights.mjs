#!/usr/bin/env node
// Regenerates tools/integration-test-weights.json from the `[node-test-duration]` lines that
// tools/run-node-tests.mjs prints in every integration shard, so shard balance and the shard budget
// follow measured durations instead of a hand-kept table. Pass one log per CI run of main:
//   gh run view <run-id> --log > run-<run-id>.log
//   node tools/refresh-integration-test-weights.mjs run-<a>.log run-<b>.log run-<c>.log
// Each file takes the median of its samples, so one slow runner does not move the table.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestTierManifest } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "tools", "integration-test-weights.json");
const durationLine = /\[node-test-duration\] (\d+) (\S+)\s*$/u;

export function integrationWeightsFromLogs(logs, integrationFiles) {
  const known = new Set(integrationFiles);
  const samples = new Map();
  for (const log of logs) {
    const perFile = new Map();
    for (const line of log.split(/\r?\n/u)) {
      const match = durationLine.exec(line);
      if (match !== null && known.has(match[2])) perFile.set(match[2], Number(match[1]));
    }
    for (const [file, durationMs] of perFile) samples.set(file, [...(samples.get(file) ?? []), durationMs]);
  }
  const weights = {};
  for (const file of [...samples.keys()].sort()) {
    const sorted = samples.get(file).sort((left, right) => left - right);
    weights[file] = Math.max(100, Math.round(sorted[Math.floor(sorted.length / 2)] / 100) * 100);
  }
  return weights;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const logPaths = process.argv.slice(2);
  if (logPaths.length === 0) throw new Error("pass at least one `gh run view <run-id> --log` output file");
  const integrationFiles = discoverTestTierManifest(repoRoot).integration;
  const weights = integrationWeightsFromLogs(
    logPaths.map((file) => readFileSync(file, "utf8")),
    integrationFiles,
  );
  const unmeasured = integrationFiles.filter((file) => !(file in weights));
  writeFileSync(outputPath, `${JSON.stringify(weights, null, 2)}\n`);
  console.log(`wrote ${Object.keys(weights).length} weights from ${logPaths.length} logs`);
  if (unmeasured.length > 0) console.log(`no sample (default weight applies): ${unmeasured.join(", ")}`);
}
