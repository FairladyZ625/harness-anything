#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const output = process.env.HARNESS_CI_OBSERVATION_OUTPUT ?? "tmp/ci-observation/observation.json",
  started = Number(process.env.HARNESS_CI_JOB_STARTED_MS ?? Date.now()),
  tests = readTests(),
  tier = process.env.HARNESS_TEST_TIER ?? "unknown",
  shard = optionalPositiveInteger(process.env.HARNESS_TEST_SHARD),
  artifact = {
    schema: "ci-run-artifact/v1",
    run: {
      runId: githubRunId(),
      sha: process.env.GITHUB_SHA ?? "local",
      branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "local",
      prNumber: optionalPositiveInteger(process.env.HARNESS_PR_NUMBER),
      job: process.env.HARNESS_CI_JOB ?? process.env.GITHUB_JOB ?? "local",
      wallclockMs: Math.max(0, Date.now() - started),
      runner: process.env.RUNNER_NAME ?? process.env.RUNNER_OS ?? process.platform,
    },
    tests: tests.map((entry) => ({ ...entry, tier: entry.tier ?? tier, shard: entry.shard ?? shard })),
    gates: readGates(),
  };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(output);

function optionalPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function githubRunId() {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return `local-${Date.now()}`;
  return process.env.GITHUB_RUN_ATTEMPT ? `${runId}.${process.env.GITHUB_RUN_ATTEMPT}` : runId;
}

function readGates() {
  const source = process.env.HARNESS_CI_GATE_RESULTS;
  if (!source || !existsSync(source)) return [];
  return JSON.parse(readFileSync(source, "utf8"));
}

function readTests() {
  const sources = [
    process.env.HARNESS_CI_NODE_TEST_RESULTS,
    process.env.HARNESS_CI_VITEST_RESULTS,
    process.env.HARNESS_CI_NODE_TEST_RESULTS || process.env.HARNESS_CI_VITEST_RESULTS
      ? undefined
      : process.env.HARNESS_CI_OBSERVATION_RAW,
  ].filter((source) => source && existsSync(source));
  return sources.flatMap((source) => normalizeTests(JSON.parse(readFileSync(source, "utf8"))));
}

export function normalizeTests(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || !Array.isArray(value.testResults)) return [];
  return value.testResults.flatMap((file) => {
    const fileName = typeof file?.name === "string" ? file.name.replaceAll("\\\\", "/") : "unknown";
    return Array.isArray(file?.assertionResults)
      ? file.assertionResults.map((result) => ({
          file: fileName,
          name:
            typeof result.fullName === "string"
              ? result.fullName
              : typeof result.title === "string"
                ? result.title
                : "unknown",
          tier: "gui",
          shard: null,
          durationMs:
            typeof result.duration === "number" && Number.isFinite(result.duration) ? Math.max(0, result.duration) : 0,
          status:
            result.status === "passed"
              ? "passed"
              : result.status === "pending" || result.status === "todo"
                ? "skipped"
                : "failed",
          retry: 0,
        }))
      : [];
  });
}
