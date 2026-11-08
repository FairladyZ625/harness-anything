// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildPrBodyWorkflowPlan, prBodyWorkflowJobs } from "./check-pr-body-workflow.mjs";
import { parseGateWorkflow } from "./gate-workflow-parser.mjs";
import { runManifestGatePlan } from "./run-manifest-gates.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const entryPath = path.join(repoRoot, "tools/check-pr-body-workflow.mjs");
const workflowText = () => readFileSync(path.join(repoRoot, ".github/workflows/pr-body.yml"), "utf8");
const manifest = () => JSON.parse(readFileSync(path.join(repoRoot, "tools/gate-manifest.json"), "utf8"));

function fixtureWorkflow(jobs) {
  return [
    "name: pr-body",
    "on:",
    "  pull_request:",
    "jobs:",
    ...jobs.flatMap((job) => [
      `  ${job}:`,
      "    if: github.event_name == 'pull_request'",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - run: node tools/run-manifest-gates.mjs --workflow-job ${job}`,
    ]),
    "",
  ].join("\n");
}

function fixtureManifest(jobs) {
  return {
    surfaces: { prBody: { pullRequestGateJobs: jobs, helperJobsNotRegisteredAsGates: [] } },
    gates: jobs.map((job, index) => ({
      id: `body-check-${index + 1}`,
      command: `node body-check-${index + 1}.mjs`,
      executionSurfaces: { prBody: { pullRequestJobs: [job] } },
    })),
  };
}

test("the local entry derives every pr-body workflow job from the workflow file", () => {
  const jobs = prBodyWorkflowJobs(manifest(), parseGateWorkflow(workflowText()));

  assert.ok(jobs.includes("pr-body-lint"));
  assert.deepEqual(jobs.sort(), (manifest().surfaces?.prBody?.pullRequestGateJobs ?? []).slice().sort());
});

test("the local entry's gate set equals the manifest gates declared on the workflow's jobs", () => {
  const manifestValue = manifest();
  const workflow = parseGateWorkflow(workflowText());
  const jobs = prBodyWorkflowJobs(manifestValue, workflow);
  const declared = manifestValue.gates
    .filter((gate) => (gate.executionSurfaces?.prBody?.pullRequestJobs ?? []).some((job) => jobs.includes(job)))
    .map((gate) => gate.id)
    .sort();
  const planned = buildPrBodyWorkflowPlan(manifestValue, workflowText())
    .commands.map((entry) => entry.id)
    .sort();

  assert.deepEqual(planned, declared);
  assert.ok(planned.length > 0);
});

test("a body check added to a workflow job enters the plan with no second list to edit", () => {
  const first = buildPrBodyWorkflowPlan(fixtureManifest(["body-lane"]), fixtureWorkflow(["body-lane"]));
  assert.deepEqual(
    first.commands.map((entry) => entry.id),
    ["body-check-1"],
  );

  const second = buildPrBodyWorkflowPlan(
    fixtureManifest(["body-lane", "second-body-lane"]),
    fixtureWorkflow(["body-lane", "second-body-lane"]),
  );
  assert.deepEqual(
    second.commands.map((entry) => entry.id),
    ["body-check-1", "body-check-2"],
  );
});

test("a workflow job that declares no manifest gate fails the plan instead of reading green", () => {
  assert.throws(
    () => buildPrBodyWorkflowPlan(fixtureManifest(["body-lane"]), fixtureWorkflow(["body-lane", "unregistered-lane"])),
    /unregistered-lane selected 0 gates|no gate declares it/u,
  );
});

test("the plan executes every gate before reporting the aggregate failure", () => {
  const calls = [];
  const result = runManifestGatePlan([{ id: "first" }, { id: "second" }, { id: "third" }], {
    execute: (entry) => {
      calls.push(entry.id);
      return { ok: entry.id !== "second", durationMs: 1 };
    },
  });

  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.deepEqual(result.failedGateIds, ["second"]);
});

test("stopOnFailure preserves the package aggregate's historical short-circuit", () => {
  const calls = [];
  runManifestGatePlan([{ id: "first" }, { id: "second" }, { id: "third" }], {
    stopOnFailure: true,
    execute: (entry) => {
      calls.push(entry.id);
      return { ok: false, durationMs: 1 };
    },
  });
  assert.deepEqual(calls, ["first"]);
});

test("--list prints every derived job and gate without requiring a body", () => {
  const output = execFileSync(process.execPath, [entryPath, "--list"], { cwd: repoRoot, encoding: "utf8" });
  const plan = buildPrBodyWorkflowPlan(manifest(), workflowText());
  for (const job of plan.jobs) assert.match(output, new RegExp(`^${job}:$`, "mu"));
  for (const entry of plan.commands) assert.match(output, new RegExp(`^  ${entry.id}  `, "mu"));
});
