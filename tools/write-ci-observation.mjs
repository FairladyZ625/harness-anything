#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ciFailureDiagnostic, ciFailureLocation, ciTestOutcome } from "./node-test-observation-reporter.mjs";

export function normalizeTests(value) {
  if (!value || !Array.isArray(value.testResults)) throw new Error("invalid Vitest observation report");
  return value.testResults.flatMap((file) => {
    const fileName = relativeFile(file.name);
    const ordinals = new Map();
    return (file.assertionResults ?? []).map((result) => {
      const suite = result.ancestorTitles ?? [];
      const name = result.title;
      const key = JSON.stringify([fileName, suite, name, result.location ?? null]);
      const ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      const status = ciTestOutcome(result.status);
      return {
        kind: "test",
        file: fileName,
        name,
        suite,
        testKey: `${key}:${ordinal}`,
        executionOrdinal: ordinal,
        declarationLocation: { line: result.location?.line ?? null, column: result.location?.column ?? null },
        failureLocation: ciFailureLocation({ stack: result.failureMessages?.join("\n") }, process.cwd()),
        tier: "gui",
        shard: null,
        durationMs: Math.max(0, result.duration ?? 0),
        status,
        ...(status === "failed"
          ? ciFailureDiagnostic({
              name: "VitestError",
              message: result.failureMessages?.join("\n") ?? "",
              stack: result.failureMessages?.join("\n"),
            })
          : {}),
      };
    });
  });
}

function relativeFile(file) {
  const normalized = file.replaceAll("\\", "/"),
    root = `${process.cwd().replaceAll("\\", "/")}/`;
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}
function readFragments(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) return readFragments(file);
      if (!file.endsWith(".jsonl")) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    });
}
export function writeCiObservation(env = process.env) {
  const output = env.HARNESS_CI_OBSERVATION_OUTPUT ?? "tmp/ci-observation/observation.json";
  const fragments = readFragments(env.HARNESS_CI_NODE_TEST_RESULTS ?? env.HARNESS_CI_OBSERVATION_RAW);
  const vitest =
    env.HARNESS_CI_VITEST_RESULTS && existsSync(env.HARNESS_CI_VITEST_RESULTS)
      ? JSON.parse(readFileSync(env.HARNESS_CI_VITEST_RESULTS, "utf8"))
      : null;
  const tests = [...fragments.filter((entry) => entry.kind === "test"), ...(vitest ? normalizeTests(vitest) : [])];
  const coverage = fragments.filter((entry) => entry.kind === "coverage");
  const fileOutcomes = fragments.filter((entry) => entry.kind === "file");
  if (vitest)
    for (const file of vitest.testResults) {
      if (file.status === "failed" && !file.assertionResults?.length)
        fileOutcomes.push({
          file: relativeFile(file.name),
          outcome: "crashed",
          reason: "Vitest file failed before tests",
          stallSummary: ciFailureDiagnostic(file.message).failureSummary,
          truncated: ciFailureDiagnostic(file.message).truncated,
          error: ciFailureDiagnostic(file.message).error,
          diagnosticRef: null,
        });
    }
  const missing = coverage.filter((entry) => entry.missingReason);
  const startedFileCount = coverage.length
    ? coverage.reduce((sum, entry) => sum + entry.startedFiles.length, 0)
    : (vitest?.testResults.length ?? null);
  const completedFileCount = coverage.length
    ? coverage.reduce((sum, entry) => sum + entry.completedFiles.length, 0)
    : (vitest?.testResults.length ?? null);
  const databaseRunId = env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT ?? 1);
  const artifact = {
    schema: "ci-run-artifact/v2",
    producer: {
      repositoryId: env.GITHUB_REPOSITORY ?? "local",
      workflow: env.GITHUB_WORKFLOW_REF?.split("@")[0].split("/").slice(2).join("/") ?? "local",
      databaseRunId,
      runAttempt,
      jobKey: JSON.stringify([env.GITHUB_JOB ?? "local", JSON.parse(env.HARNESS_CI_JOB_MATRIX ?? "{}")]),
      jobName: env.HARNESS_CI_JOB ?? env.GITHUB_JOB ?? "local",
    },
    run: {
      runId: env.GITHUB_RUN_ID ? `${databaseRunId}.${runAttempt}` : databaseRunId,
      sha: env.GITHUB_SHA ?? "local",
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "local",
      prNumber: env.HARNESS_PR_NUMBER ? Number(env.HARNESS_PR_NUMBER) : null,
      job: env.HARNESS_CI_JOB ?? env.GITHUB_JOB ?? "local",
      wallclockMs: Math.max(0, Date.now() - Number(env.HARNESS_CI_JOB_STARTED_MS ?? Date.now())),
      runner: env.RUNNER_NAME ?? env.RUNNER_OS ?? process.platform,
    },
    gates:
      env.HARNESS_CI_GATE_RESULTS && existsSync(env.HARNESS_CI_GATE_RESULTS)
        ? JSON.parse(readFileSync(env.HARNESS_CI_GATE_RESULTS, "utf8"))
        : [],
    measurementCoverage: {
      status: missing.length || fileOutcomes.length ? "partial" : startedFileCount === null ? "unknown" : "complete",
      missingReason:
        missing.map((entry) => entry.missingReason).join("; ") ||
        (startedFileCount === null ? "no runner measurement" : fileOutcomes.length ? "abnormal test file" : null),
      startedFileCount,
      completedFileCount,
    },
    detail: {
      schema: "ci-run-detail/v1",
      tests: tests.map(({ kind: _kind, ...entry }) => entry),
      fileOutcomes: fileOutcomes.map(({ kind: _kind, ...entry }) => entry),
      diagnostics: fragments.filter((entry) => entry.kind === "diagnostic"),
    },
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(artifact)}\n`);
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(writeCiObservation());
