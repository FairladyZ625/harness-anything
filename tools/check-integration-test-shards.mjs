#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { integrationShardCount, integrationShardSummaries, validateIntegrationTestShards } from "./integration-test-shards.mjs";
import { testTierManifest } from "./test-tier-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github/workflows/rewrite-ci.yml");

export function checkIntegrationTestShards({ workflowText = readFileSync(workflowPath, "utf8") } = {}) {
  const validation = validateIntegrationTestShards(testTierManifest.integration);
  const workflowValidation = validateIntegrationShardWorkflowMatrix(workflowText, integrationShardCount);
  const errors = [...validation.errors, ...workflowValidation.errors];
  return {
    ok: errors.length === 0,
    errors,
    summaries: integrationShardSummaries(),
    fileCount: testTierManifest.integration.length,
    workflowShards: workflowValidation.shards
  };
}

export function validateIntegrationShardWorkflowMatrix(workflowText, shardCount = integrationShardCount) {
  const shards = parseIntegrationShardMatrix(workflowText);
  const expected = Array.from({ length: shardCount }, (_, index) => index + 1);
  const errors = [];

  if (shards.length === 0) {
    errors.push("integration-shard workflow matrix shard list is missing");
    return { shards, errors };
  }
  if (shards.length !== expected.length || shards.some((value, index) => value !== expected[index])) {
    errors.push(`integration-shard workflow matrix mismatch: expected [${expected.join(", ")}], got [${shards.join(", ")}]`);
  }

  return { shards, errors };
}

function parseIntegrationShardMatrix(workflowText) {
  const lines = workflowText.split(/\r?\n/u);
  let inIntegrationShardJob = false;
  let jobIndent = 0;

  for (const line of lines) {
    const jobMatch = /^(\s*)integration-shard:\s*$/u.exec(line);
    if (jobMatch) {
      inIntegrationShardJob = true;
      jobIndent = jobMatch[1].length;
      continue;
    }
    if (!inIntegrationShardJob) {
      continue;
    }
    const nextJobMatch = /^(\s*)[A-Za-z0-9_-]+:\s*$/u.exec(line);
    if (nextJobMatch && nextJobMatch[1].length <= jobIndent) {
      return [];
    }
    const shardMatch = /^\s*shard:\s*\[(.+?)\]\s*$/u.exec(line);
    if (shardMatch) {
      return shardMatch[1]
        .split(",")
        .map((entry) => Number(entry.trim()))
        .filter((value) => Number.isInteger(value));
    }
  }

  return [];
}

function main() {
  const result = checkIntegrationTestShards();
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`integration shard check passed: manifestFiles=${result.fileCount} shards=${result.summaries.length} workflowShards=[${result.workflowShards.join(", ")}]`);
  for (const summary of result.summaries) {
    console.log(`shard ${summary.id}: files=${summary.files} estimatedMs=${summary.estimatedMs.toFixed(1)}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
