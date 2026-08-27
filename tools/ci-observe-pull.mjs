#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Pulls CI observation artifacts to a local directory. The daemon owns ledger ingestion; this
 * helper only downloads and validates the structured artifact boundary. */
export function pullCiObservationArtifacts({ runId, outputDir = "tmp/ci-observation/pulled", gh = "gh" }) {
  mkdirSync(outputDir, { recursive: true });
  const args = ["run", "download", String(runId), "--dir", outputDir];
  execFileSync(gh, args, { stdio: "inherit" });
  return readObservationArtifacts(outputDir);
}

export function readObservationArtifacts(outputDir) {
  const artifacts = [];
  for (const file of walk(outputDir)) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.schema !== "ci-run-artifact/v1") continue;
    if (!value.run || !Array.isArray(value.tests) || !Array.isArray(value.gates))
      throw new Error(`invalid CI artifact: ${file}`);
    artifacts.push(value);
  }
  return artifacts.sort((left, right) => String(left.run.runId).localeCompare(String(right.run.runId)));
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const runId = process.argv[2];
  if (!runId) throw new Error("usage: node tools/ci-observe-pull.mjs <run-id> [output-dir]");
  const artifacts = pullCiObservationArtifacts({ runId, outputDir: process.argv[3] ?? "tmp/ci-observation/pulled" });
  writeFileSync(
    path.join(process.argv[3] ?? "tmp/ci-observation/pulled", "index.json"),
    `${JSON.stringify(artifacts, null, 2)}\n`,
  );
  console.log(`pulled ${artifacts.length} CI observation artifact(s)`);
}
