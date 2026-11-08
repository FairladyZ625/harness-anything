// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildPrBodyWorkflowPlan, prBodyWorkflowJobs } from "./check-pr-body-workflow.mjs";
import { commitAll, makeRepo, writeRepoFile } from "./gates/test/helpers.mjs";
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

test("a custom --base applies to every derived gate that compares against a base", () => {
  // HEAD..HEAD has no dependency change, so the declaration gate must agree with production-delta
  // that the selected cut is empty. A gate pinned to origin/main instead would reject this body
  // for a dependency change the requested base does not contain.
  const body = [
    "## Summary",
    "A custom-base body used to check that every base-aware gate shares one comparison.",
    "",
    "## What Changed",
    "No repository paths are compared against the selected base.",
    "",
    "## Machine-Readable Declarations",
    "",
    "## Verification",
    "The local entry ran every derived gate against HEAD..HEAD.",
    "",
    "## Residual Risk",
    "The check covers base selection, not hosted CI behavior.",
    "",
  ].join("\n");
  const result = spawnSync(process.execPath, [entryPath, "--body", body, "--base", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

const BASE_INPUT = /--base(?:-env)? (?:PR_BASE_SHA|"\$PR_BASE_SHA")/u;
const RECORDER = [
  'import { appendFileSync } from "node:fs";',
  'import process from "node:process";',
  "const argv = process.argv.slice(2);",
  "let base = null;",
  "for (let index = 0; index < argv.length; index += 1) {",
  '  if (argv[index] === "--base") base = argv[index + 1];',
  '  else if (argv[index] === "--base-env") base = process.env[argv[index + 1]] ?? null;',
  "}",
  'appendFileSync("received-base.jsonl", JSON.stringify({ argv, base }) + "\\n");',
  "",
].join("\n");

function baseAwareGates(value = manifest()) {
  return value.gates.filter((gate) => BASE_INPUT.test(gate.command));
}

test("every base-aware gate receives the entry's selected --base", () => {
  // Derive the fixture from the live manifest so the set of base-aware gates is not hand-copied:
  // the same three commands that consume a comparison base are wrapped with an argv recorder.
  const gates = baseAwareGates();
  assert.deepEqual(gates.map((gate) => gate.id).sort(), [
    "dependency-policy-declaration",
    "pr-governance-lint",
    "production-delta",
  ]);
  const fixture = makeRepo({
    ".github/workflows/pr-body.yml": fixtureWorkflow(["body-lane"]),
    "record-args.mjs": RECORDER,
    "tools/gate-manifest.json": JSON.stringify({
      surfaces: { prBody: { pullRequestGateJobs: ["body-lane"], helperJobsNotRegisteredAsGates: [] } },
      gates: gates.map((gate) => ({
        id: gate.id,
        command: `node record-args.mjs ${gate.id} ${gate.command.match(BASE_INPUT)[0]}`,
        executionSurfaces: { prBody: { pullRequestJobs: ["body-lane"] } },
      })),
    }),
  });
  // Move HEAD past the selected base: an entry that ignored --base and fell back to HEAD would
  // record a different commit in at least one gate.
  writeRepoFile(fixture.rootDir, "fixture-head.txt", "head\n");
  const head = commitAll(fixture.rootDir);
  assert.notEqual(head, fixture.base);

  const result = spawnSync(
    process.execPath,
    [entryPath, "--root", fixture.rootDir, "--body", "Body for the base propagation check.", "--base", fixture.base],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const received = readFileSync(path.join(fixture.rootDir, "received-base.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    received.map((entry) => entry.base),
    gates.map(() => fixture.base),
  );
});

test("--head is rejected as an unknown argument", () => {
  const result = spawnSync(process.execPath, [entryPath, "--body", "Body", "--head", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /unknown argument: --head/u);
});
