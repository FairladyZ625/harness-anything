#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  integrationShardCount,
  integrationShardSummaries,
  integrationTestFileWeightsMs,
  nightlyTestFileWeightsMs,
  validateNightlyTestWeights,
  validateIntegrationTestShards
} from "./integration-test-shards.mjs";
import {
  discoverTestFiles,
  discoverTestTierManifest,
  parseTestTierMarker
} from "./test-tier-manifest.mjs";
import { validateManifest } from "./node-test-runner-lib.mjs";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(defaultRepoRoot, ".github/workflows/rewrite-ci.yml");
const gateManifestPath = path.join(defaultRepoRoot, "tools/gate-manifest.json");
const deletionAllowlistRelativePath = "tools/gate-allowlists/check-integration-test-shards.json";

export function checkIntegrationTestShards({
  repoRoot = defaultRepoRoot,
  weightOverrides = integrationTestFileWeightsMs,
  nightlyWeightOverrides,
  previousTestCount,
  baselineRef,
  workflowText = readFileSync(workflowPath, "utf8"),
  gateManifestText = readFileSync(gateManifestPath, "utf8"),
  deletionAllowlistText
} = {}) {
  const testFiles = discoverTestFiles(repoRoot);
  const testTierManifest = discoverTestTierManifest(repoRoot);
  const integrationFiles = testTierManifest.integration;
  const nightlyFiles = testTierManifest.nightly;
  const manifestValidation = validateManifest(testFiles, testTierManifest);
  const shardValidation = validateIntegrationTestShards(integrationFiles, weightOverrides);
  const resolvedNightlyWeights = nightlyWeightOverrides
    ?? (repoRoot === defaultRepoRoot ? nightlyTestFileWeightsMs : {});
  const nightlyWeightValidation = validateNightlyTestWeights(nightlyFiles, resolvedNightlyWeights);
  const workflowValidation = validateIntegrationShardWorkflowMatrix(workflowText, integrationShardCount);
  const gateValidation = validateIntegrationShardRequiredContexts(gateManifestText, integrationShardCount);
  const baseline = previousTestCount === undefined
    ? previousIntegrationTestState(repoRoot, baselineRef)
    : { count: previousTestCount, files: null, ref: null };
  const resolvedPreviousCount = baseline.count;
  const delta = resolvedPreviousCount === null ? null : integrationFiles.length - resolvedPreviousCount;
  const deletionValidation = validateIntentionalTestDeletions({
    repoRoot,
    testFiles,
    integrationFiles,
    nightlyFiles,
    baseline,
    delta,
    currentText: deletionAllowlistText
  });
  const ratchetErrors = resolvedPreviousCount === null
    ? ["unable to resolve previous integration test count from Git baseline"]
    : deletionValidation.errors;
  const errors = [
    ...manifestValidation.errors,
    ...shardValidation.errors,
    ...nightlyWeightValidation.errors,
    ...workflowValidation.errors,
    ...gateValidation.errors,
    ...ratchetErrors
  ];

  return {
    ok: errors.length === 0,
    errors,
    derivedFiles: integrationFiles,
    executionFiles: integrationFiles,
    nightlyFiles,
    summaries: integrationShardSummaries(integrationFiles, weightOverrides),
    currentCount: integrationFiles.length,
    previousCount: resolvedPreviousCount,
    delta,
    deletedFiles: deletionValidation.deletedFiles,
    movedToNightlyFiles: deletionValidation.movedToNightlyFiles,
    confirmedDeletions: deletionValidation.confirmedDeletions,
    workflowShards: workflowValidation.shards,
    requiredContexts: gateValidation.contexts
  };
}

export function validateIntegrationShardWorkflowMatrix(workflowText, shardCount = integrationShardCount) {
  const shards = parseIntegrationShardMatrix(workflowText);
  const expected = Array.from({ length: shardCount }, (_, index) => index + 1);
  const errors = [];
  if (shards.length === 0) {
    errors.push("integration-shard workflow matrix shard list is missing");
  } else if (!sameOrderedList(shards, expected)) {
    errors.push(`integration-shard workflow matrix mismatch: expected [${expected.join(", ")}], got [${shards.join(", ")}]`);
  }
  return { shards, errors };
}

export function validateIntegrationShardRequiredContexts(gateManifestText, shardCount = integrationShardCount) {
  const expected = Array.from({ length: shardCount }, (_, index) => `integration-shard (${index + 1})`);
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(gateManifestText);
  } catch (error) {
    return { contexts: [], errors: [`gate-manifest.json parse failed: ${error.message}`] };
  }

  const gate = Array.isArray(manifest.gates) ? manifest.gates.find((entry) => entry.id === "test-integration") : undefined;
  const githubContexts = gate?.githubContext?.requiredContexts;
  const branchProtectionContexts = gate?.executionSurfaces?.branchProtection?.contexts;
  if (!Array.isArray(githubContexts)) {
    errors.push("test-integration githubContext.requiredContexts is missing");
  } else if (!sameOrderedList(githubContexts, expected)) {
    errors.push(`test-integration githubContext.requiredContexts mismatch: expected [${expected.join(", ")}], got [${githubContexts.join(", ")}]`);
  }
  if (!Array.isArray(branchProtectionContexts)) {
    errors.push("test-integration executionSurfaces.branchProtection.contexts is missing");
  } else if (!sameOrderedList(branchProtectionContexts, expected)) {
    errors.push(`test-integration executionSurfaces.branchProtection.contexts mismatch: expected [${expected.join(", ")}], got [${branchProtectionContexts.join(", ")}]`);
  }
  return { contexts: Array.isArray(githubContexts) ? githubContexts : [], errors };
}

function previousIntegrationTestState(repoRoot, requestedRef) {
  try {
    const ref = requestedRef ?? resolveBaselineRef(repoRoot);
    if (ref === null) return { count: null, files: null, ref: null };
    const output = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "packages", "tools"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const files = output.split(/\r?\n/u).filter((file) => /\.(?:test|spec)\.(?:mjs|js|ts)$/u.test(file));
    const tiers = files.map((file) => {
      const source = execFileSync("git", ["show", `${ref}:${file}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      try {
        return parseTestTierMarker(source, file);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("test tier marker missing:")) return null;
        throw error;
      }
    });
    const missingMarkers = tiers.filter((tier) => tier === null).length;
    if (missingMarkers > 0 && missingMarkers < files.length) {
      return { count: null, files: null, ref };
    }
    const integration = missingMarkers === 0
      ? files.filter((_, index) => tiers[index] === "integration")
      : legacyIntegrationFiles(repoRoot, ref, files);
    return { count: integration.length, files: integration, ref };
  } catch {
    return { count: null, files: null, ref: null };
  }
}

function legacyIntegrationFiles(repoRoot, ref, files) {
  try {
    const source = execFileSync("git", ["show", `${ref}:tools/test-tier-manifest.mjs`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const fast = parseLegacyTierArray(source, "fast", "contract");
    const contract = parseLegacyTierArray(source, "contract", null);
    const explicitlyClassified = new Set([...fast, ...contract]);
    return files.filter((file) => !explicitlyClassified.has(file));
  } catch {
    return files;
  }
}

function parseLegacyTierArray(source, tier, nextTier) {
  const label = `${tier}:`;
  const start = source.indexOf(label);
  if (start < 0) throw new Error(`legacy test tier array missing: ${tier}`);
  const boundary = nextTier === null ? source.indexOf("\n};", start) : source.indexOf(`\n  ${nextTier}:`, start);
  if (boundary < 0) throw new Error(`legacy test tier array boundary missing: ${tier}`);
  const segment = source.slice(start + label.length, boundary);
  const arrayStart = segment.indexOf("[");
  const arrayEnd = segment.lastIndexOf("]");
  if (arrayStart < 0 || arrayEnd < arrayStart) throw new Error(`legacy test tier array invalid: ${tier}`);
  return JSON.parse(segment.slice(arrayStart, arrayEnd + 1));
}

function validateIntentionalTestDeletions({ repoRoot, testFiles, integrationFiles, nightlyFiles, baseline, delta, currentText }) {
  const current = parseDeletionAllowlist(
    currentText ?? readDeletionAllowlist(repoRoot),
    deletionAllowlistRelativePath
  );
  const previous = baseline.ref === null
    ? { paths: [], errors: [] }
    : parseDeletionAllowlist(readBaselineDeletionAllowlist(repoRoot, baseline.ref), `${baseline.ref}:${deletionAllowlistRelativePath}`);
  const errors = [...current.errors, ...previous.errors];
  const previousPaths = new Set(previous.paths);
  const newlyConfirmed = current.paths.filter((file) => !previousPaths.has(file));
  const previousIntegration = new Set(baseline.files ?? []);
  const currentIntegration = new Set(integrationFiles);
  const currentNightly = new Set(nightlyFiles);
  const movedToNightlyFiles = baseline.files === null
    ? []
    : [...previousIntegration].filter((file) => !currentIntegration.has(file) && currentNightly.has(file)).sort();
  const deletedFiles = baseline.files === null
    ? []
    : [...previousIntegration].filter((file) => !currentIntegration.has(file) && !currentNightly.has(file)).sort();
  const deletedSet = new Set(deletedFiles);
  const confirmedDeletions = deletedFiles.filter((file) => newlyConfirmed.includes(file));

  for (const file of current.paths) {
    if (testFiles.includes(file)) errors.push(`intentional test deletion path exists on disk: ${file}`);
  }
  for (const file of newlyConfirmed) {
    if (!deletedSet.has(file)) errors.push(`new intentional test deletion confirmation does not match a baseline deletion: ${file}`);
  }
  for (const file of movedToNightlyFiles) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    if (!/^\/\/ harness-test-tier-decision: (?:ADR-\d{4}|dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)$/mu.test(source)) {
      errors.push(`integration test moved to nightly without a decision reference: ${file}`);
    }
  }

  if (delta < 0) {
    if (baseline.files === null) {
      errors.push(`integration test count decreased: current=${integrationFiles.length} previous=${baseline.count} delta=${delta}`);
    } else {
      const unconfirmed = deletedFiles.filter((file) => !newlyConfirmed.includes(file));
      if (unconfirmed.length > 0) {
        errors.push(`integration test count decreased without path confirmation: current=${integrationFiles.length} previous=${baseline.count} delta=${delta} unconfirmed=[${unconfirmed.join(", ")}]`);
      }
    }
  }

  return { errors, deletedFiles, movedToNightlyFiles, confirmedDeletions };
}

function readDeletionAllowlist(repoRoot) {
  try {
    return readFileSync(path.join(repoRoot, deletionAllowlistRelativePath), "utf8");
  } catch (error) {
    return JSON.stringify({ readError: error.message });
  }
}

function readBaselineDeletionAllowlist(repoRoot, ref) {
  try {
    return execFileSync("git", ["show", `${ref}:${deletionAllowlistRelativePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return emptyDeletionAllowlistText();
  }
}

function parseDeletionAllowlist(text, displayPath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { paths: [], errors: [`${displayPath} is not valid JSON: ${error.message}`] };
  }
  if (parsed.readError) return { paths: [], errors: [`unable to read ${displayPath}: ${parsed.readError}`] };
  if (parsed.schema !== "harness-anything/gate-allowlist/v1" || parsed.gateId !== "check-integration-test-shards") {
    return { paths: [], errors: [`${displayPath} must be a check-integration-test-shards gate allowlist`] };
  }
  const entries = parsed.entries?.intentionalTestDeletions;
  if (!Array.isArray(entries)) return { paths: [], errors: [`${displayPath} missing entries.intentionalTestDeletions`] };
  const paths = [];
  const errors = [];
  for (const [index, entry] of entries.entries()) {
    const label = `${displayPath} entries.intentionalTestDeletions[${index}]`;
    if (typeof entry?.value !== "string" || !/^(?:packages|tools)\/.+\.(?:test|spec)\.(?:mjs|js|ts)$/u.test(entry.value)) {
      errors.push(`${label}.value must be an exact repository test file path`);
      continue;
    }
    if (typeof entry.ref !== "string" || !/^(?:ADR-\d{4}|dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)/u.test(entry.ref)) {
      errors.push(`${label}.ref must cite an ADR, decision, or task id`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") errors.push(`${label}.reason must be non-empty`);
    if (paths.includes(entry.value)) errors.push(`${label}.value is duplicated: ${entry.value}`);
    paths.push(entry.value);
  }
  return { paths, errors };
}

function emptyDeletionAllowlistText() {
  return JSON.stringify({
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-integration-test-shards",
    entries: { intentionalTestDeletions: [] }
  });
}

function resolveBaselineRef(repoRoot) {
  if (!process.env.CI && process.env.HARNESS_TEST_COUNT_BASE_REF) return process.env.HARNESS_TEST_COUNT_BASE_REF;
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  const worktreeChanges = git(repoRoot, ["status", "--porcelain", "--", "packages", "tools"]);
  if (worktreeChanges) return head;
  const mergeBase = git(repoRoot, ["merge-base", "HEAD", "origin/main"]);
  if (mergeBase !== null && mergeBase !== head) return mergeBase;
  return git(repoRoot, ["rev-parse", "HEAD^"]);
}

function git(repoRoot, args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function sameOrderedList(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
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
    if (!inIntegrationShardJob) continue;
    const nextJobMatch = /^(\s*)[A-Za-z0-9_-]+:\s*$/u.exec(line);
    if (nextJobMatch && nextJobMatch[1].length <= jobIndent) return [];
    const shardMatch = /^\s*shard:\s*\[(.+?)\]\s*$/u.exec(line);
    if (shardMatch) {
      return shardMatch[1].split(",").map((entry) => Number(entry.trim())).filter(Number.isInteger);
    }
  }
  return [];
}

function main() {
  const result = checkIntegrationTestShards();
  if (!result.ok) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const previous = result.previousCount === null ? "unavailable" : result.previousCount;
  const delta = result.delta === null ? "unavailable" : result.delta;
  console.log(`integration shard check passed: current=${result.currentCount} previous=${previous} delta=${delta} shards=${result.summaries.length} workflowShards=[${result.workflowShards.join(", ")}] requiredContexts=[${result.requiredContexts.join(", ")}]`);
  for (const summary of result.summaries) {
    console.log(`shard ${summary.id}: files=${summary.files} estimatedMs=${summary.estimatedMs.toFixed(1)} workMs=${summary.estimatedWorkMs.toFixed(1)}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
