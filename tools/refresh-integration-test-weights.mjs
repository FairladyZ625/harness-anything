#!/usr/bin/env node
// Regenerates tools/integration-test-weights.json from CI observation artifacts, so shard balance
// follows measured durations instead of a hand-kept table. Usage:
//   gh run download <main-run-id> -p "ci-observation-*-integration-*" -D <dir>   (one or more runs)
//   node tools/refresh-integration-test-weights.mjs <dir>...
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestTierManifest } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "tools", "integration-test-weights.json");
// Files below this stay on the default weight: they do not move the balance, and leaving them out
// keeps the table short enough to review.
const minimumWeightMs = 2000;

export function integrationWeightsFromObservations(observations, integrationFiles) {
  const known = new Set(integrationFiles);
  const samples = new Map();
  for (const observation of observations) {
    const perFile = new Map();
    for (const test of observation.tests ?? []) {
      if (test.tier !== "integration" || !known.has(test.file)) continue;
      perFile.set(test.file, (perFile.get(test.file) ?? 0) + test.durationMs);
    }
    for (const [file, durationMs] of perFile) samples.set(file, [...(samples.get(file) ?? []), durationMs]);
  }
  const weights = {};
  for (const file of [...samples.keys()].sort()) {
    const sorted = samples.get(file).sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median >= minimumWeightMs) weights[file] = Math.round(median / 100) * 100;
  }
  return weights;
}

function observationFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = path.join(directory, entry);
    if (statSync(entryPath).isDirectory()) return observationFiles(entryPath);
    return entry === "observation.json" ? [entryPath] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = process.argv.slice(2);
  if (directories.length === 0) throw new Error("pass at least one directory of downloaded ci-observation artifacts");
  const observations = directories.flatMap(observationFiles).map((file) => JSON.parse(readFileSync(file, "utf8")));
  const integrationFiles = discoverTestTierManifest(repoRoot).integration;
  const weights = integrationWeightsFromObservations(observations, integrationFiles);
  writeFileSync(outputPath, `${JSON.stringify(weights, null, 2)}\n`);
  console.log(`wrote ${Object.keys(weights).length} weights from ${observations.length} observations`);
}
