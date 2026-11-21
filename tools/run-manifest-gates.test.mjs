// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, renameSync, rmSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, makeRepo, runGit, writeRepoFile } from "./gates/test/helpers.mjs";
import {
  authorizationGateConcurrencyForPool,
  buildManifestGatePlan,
  commandForPlatformShell,
  parseManifestGateArgs,
  runManifestGatePlan,
  runManifestGatePlanParallel,
  selectManifestGateIds,
  shouldSkipTestQuarantine,
} from "./run-manifest-gates.mjs";

test("manifest gate runner can group each quick-gate command for GitHub logs", () => {
  const lines = [],
    logged = [],
    originalLog = console.log;
  console.log = (line) => logged.push(line);
  try {
    const result = runManifestGatePlan(
      [
        { id: "typecheck", command: "npm run typecheck" },
        { id: "lint", command: "npm run lint" },
      ],
      {
        githubGroups: true,
        execute: (entry) => {
          lines.push(`ran:${entry.id}`);
          return { ok: true };
        },
      },
    );
    assert.deepEqual(result.failedGateIds, []);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(lines, ["ran:typecheck", "ran:lint"]);
  assert.deepEqual(logged, ["::group::typecheck", "::endgroup::", "::group::lint", "::endgroup::"]);
});

test("manifest gate runner parses a positive --parallel value", () => {
  assert.equal(parseManifestGateArgs(["--workflow-job", "quick-gates", "--parallel", "4"]).parallel, 4);
  assert.throws(
    () => parseManifestGateArgs(["--workflow-job", "quick-gates", "--parallel", "0"]),
    /--parallel must be a positive integer/u,
  );
});

function authorizationManifest() {
  const executionSurfaces = {
    rewriteCi: { pullRequestJobs: ["quick-gates"], nonPullRequestJobs: ["quick-gates"] },
  };
  return {
    gates: [
      {
        id: "ontology-durable-action-authorization",
        command: "node tools/capture.mjs authorization",
        executionSurfaces,
      },
      { id: "other", command: "node tools/capture.mjs other", executionSurfaces },
    ],
  };
}

test("PR authorization scope is shell-neutral and does not narrow the quick-gates set", () => {
  const files = ["packages/daemon/src/路径 & 'quote'.ts", "packages\\daemon\\src\\helper.ts"];
  const manifest = authorizationManifest();
  for (const eventName of ["pull_request", "merge_group"]) {
    const options = parseManifestGateArgs(["--workflow-job", "quick-gates"]);
    Object.assign(options, { eventName, authorizationChangedPaths: files });
    const plan = buildManifestGatePlan(manifest, options);
    assert.deepEqual(
      plan.map((entry) => entry.id),
      manifest.gates.map((gate) => gate.id),
    );
    assert.equal(plan[1].command, manifest.gates[1].command);
    const command = `${manifest.gates[0].command} --changed-files-stdin`;
    assert.equal(plan[0].input, JSON.stringify(files));
    for (const platform of ["win32", "linux", "darwin"])
      assert.equal(commandForPlatformShell(plan[0].command, { platform, env: {} }), command);
  }
});

test("push and non-PR plans never append authorization scope even when supplied", () => {
  const manifest = authorizationManifest();
  for (const eventName of ["push", "schedule", "workflow_dispatch", null]) {
    const options = parseManifestGateArgs(["--workflow-job", "quick-gates"]);
    Object.assign(options, { eventName, authorizationChangedPaths: ["packages/daemon/src/helper.ts"] });
    assert.deepEqual(
      buildManifestGatePlan(manifest, options),
      manifest.gates.map(({ id, command }) => ({ id, command })),
    );
  }
});

function authorizationRunnerFixture() {
  const { rootDir } = makeRepo({
    "tools/gate-manifest.json": JSON.stringify(authorizationManifest()),
    "tools/test-quarantine.json": JSON.stringify({ schema: "harness-test-quarantine/v1", tests: [] }),
    "tools/capture.mjs": `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--changed-files-stdin")) args.push(readFileSync(0, "utf8"));
console.log("CAPTURE " + JSON.stringify(args));`,
    "old name.ts": "export const old = 1;\n",
    "deleted.ts": "export const deleted = 1;\n",
  });
  for (const file of ["run-manifest-gates.mjs", "test-quarantine.mjs"])
    cpSync(path.join(import.meta.dirname, file), path.join(rootDir, "tools", file));
  runGit(rootDir, ["config", "core.excludesFile", devNull]);
  commitAll(rootDir);
  runGit(rootDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return rootDir;
}

// dec_04A9211B073F29F0FC1E1CA573 CH3: the complete migration diff must reach the
// authorization proof without exceeding the operating system's argument limit.
for (const parallel of [false, true])
  test(`large PR authorization scope reaches the real ${parallel ? "parallel" : "sequential"} gate process`, () => {
    const root = authorizationRunnerFixture(),
      files = Array.from({ length: 3000 }, (_, index) => `packages/daemon/src/路径 & 'quote'/module-${index}.ts`);
    assert.ok(Buffer.byteLength(JSON.stringify(files)) > 131_072);
    writeRepoFile(root, "expected.json", JSON.stringify(files));
    writeRepoFile(
      root,
      "tools/capture.mjs",
      `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
assert.deepEqual(process.argv.slice(2), ["authorization", "--changed-files-stdin"]);
assert.deepEqual(JSON.parse(readFileSync(0, "utf8")), JSON.parse(readFileSync("expected.json", "utf8")));
console.log("Complete authorization scope received");`,
    );
    writeRepoFile(
      root,
      "tools/large-scope.mjs",
      `import { readFileSync } from "node:fs";
import { buildManifestGatePlan, runManifestGatePlan, runManifestGatePlanParallel } from "./run-manifest-gates.mjs";
const manifest = JSON.parse(readFileSync("tools/gate-manifest.json", "utf8"));
manifest.gates = manifest.gates.slice(0, 1);
const plan = buildManifestGatePlan(manifest, {
  workflowJob: "quick-gates", eventName: "pull_request",
  authorizationChangedPaths: JSON.parse(readFileSync("expected.json", "utf8")),
});
const result = await ${parallel ? "runManifestGatePlanParallel(plan, { concurrency: 2 })" : "runManifestGatePlan(plan)"};
process.exitCode = result.failedGateIds.length ? 1 : 0;`,
    );
    const result = spawnSync(process.execPath, ["tools/large-scope.mjs"], { cwd: root, encoding: "utf8" }),
      diagnostics = `${result.stderr}\n${result.stdout}`
        .split("\n")
        .filter((line) => line.length < 600)
        .slice(-12)
        .join("\n");
    assert.equal(result.status, 0, diagnostics);
    assert.match(result.stdout, /Complete authorization scope received/u);
  });

function capturedAuthorizationRun(rootDir, eventName, args = []) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  if (eventName === null) delete env.GITHUB_EVENT_NAME;
  else env.GITHUB_EVENT_NAME = eventName;
  const result = spawnSync(
    process.execPath,
    ["tools/run-manifest-gates.mjs", "--workflow-job", "quick-gates", ...args],
    {
      cwd: rootDir,
      env,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return [...result.stdout.matchAll(/^CAPTURE (.+)$/gmu)].map((match) => JSON.parse(match[1]));
}

test("CLI passes the exact PR merge-base diff, including both rename sides and deletions", () => {
  const root = authorizationRunnerFixture();
  renameSync(path.join(root, "old name.ts"), path.join(root, "new name.ts"));
  rmSync(path.join(root, "deleted.ts"));
  writeRepoFile(root, "路径 & 'quote'.ts", "export const value = 1;\n");
  const head = commitAll(root);
  // Advance canonical main independently: two-dot diff would incorrectly include main-only.ts.
  runGit(root, ["checkout", "--quiet", "--detach", "refs/remotes/origin/main"]);
  writeRepoFile(root, "main-only.ts", "export const mainOnly = true;\n");
  const main = commitAll(root);
  runGit(root, ["update-ref", "refs/remotes/origin/main", main]);
  runGit(root, ["checkout", "--quiet", "--detach", head]);
  writeRepoFile(root, "uncommitted.ts", "ignored by committed PR diff\n");
  for (const event of ["pull_request", "merge_group"]) {
    const captured = capturedAuthorizationRun(root, event);
    assert.deepEqual(captured[1], ["other"]);
    assert.deepEqual(captured[0].slice(0, 2), ["authorization", "--changed-files-stdin"]);
    assert.deepEqual(JSON.parse(captured[0][2]), ["deleted.ts", "new name.ts", "old name.ts", "路径 & 'quote'.ts"]);
  }
});

test("CLI preserves full authorization for push, other events, and missing PR base", () => {
  const root = authorizationRunnerFixture();
  for (const event of ["push", "schedule", "workflow_dispatch", null])
    assert.deepEqual(capturedAuthorizationRun(root, event), [["authorization"], ["other"]]);
  runGit(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
  for (const event of ["pull_request", "merge_group"])
    assert.deepEqual(capturedAuthorizationRun(root, event), [["authorization"], ["other"]]);
});

test("CLI supports an explicit comparison base without enabling push scoping", () => {
  const root = authorizationRunnerFixture();
  runGit(root, ["tag", "comparison", "HEAD"]);
  writeRepoFile(root, "leaf.ts", "export const leaf = 1;\n");
  commitAll(root);
  const args = ["--changed-base", "comparison"];
  const captured = capturedAuthorizationRun(root, "pull_request", args);
  assert.deepEqual(JSON.parse(captured[0][2]), ["leaf.ts"]);
  assert.deepEqual(capturedAuthorizationRun(root, "push", args), [["authorization"], ["other"]]);
});

test("manifest gate runner keeps a bounded pool and reports every failure in plan order", async () => {
  const started = [];
  const releases = [];
  let active = 0;
  let maxActive = 0;
  const resultPromise = runManifestGatePlanParallel([{ id: "a" }, { id: "b" }, { id: "c" }], {
    concurrency: 2,
    execute: (entry) => {
      started.push(entry.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve({ ok: entry.id !== "b" });
        });
      });
    },
  });

  assert.deepEqual(started, ["a", "b"], "the pool starts exactly its concurrency limit");
  assert.equal(maxActive, 2);
  releases.shift()();
  for (let turn = 0; turn < 10 && started.length < 3; turn += 1) await Promise.resolve();
  assert.deepEqual(started, ["a", "b", "c"], "a finished worker takes the next gate");
  while (releases.length > 0) releases.shift()();

  const result = await resultPromise;
  assert.deepEqual(
    result.results.map((entry) => entry.id),
    ["a", "b", "c"],
    "results stay in plan order even when the pool finishes out of order",
  );
  assert.deepEqual(result.failedGateIds, ["b"]);
  assert.equal(maxActive, 2);
});

test("parallel gate pool budgets authorization workers against active gate concurrency", async () => {
  const captured = [];
  const active = new Set();
  let authorizationOverlapped = false;
  let maxActive = 0;
  const plan = [
    { id: "gate-before" },
    { id: "ontology-durable-action-authorization" },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `gate-${index}` })),
  ];
  const result = await runManifestGatePlanParallel(plan, {
    concurrency: 6,
    cpuCount: 8,
    execute: async (entry) => {
      if (entry.id === "ontology-durable-action-authorization" && active.size > 0) {
        authorizationOverlapped = true;
      }
      if (active.has("ontology-durable-action-authorization")) authorizationOverlapped = true;
      active.add(entry.id);
      maxActive = Math.max(maxActive, active.size);
      captured.push(entry);
      await new Promise((resolve) => setImmediate(resolve));
      active.delete(entry.id);
      return { ok: true };
    },
  });

  assert.deepEqual(result.failedGateIds, []);
  assert.equal(authorizationGateConcurrencyForPool(8), 4);
  assert.equal(authorizationGateConcurrencyForPool(8, 6), 2);
  assert.equal(authorizationGateConcurrencyForPool(2, 6), 1);
  assert.equal(
    captured.find((entry) => entry.id === "ontology-durable-action-authorization").authorizationAuditConcurrency,
    2,
  );
  assert.equal(captured.find((entry) => entry.id === "gate-before").authorizationAuditConcurrency, undefined);
  assert.equal(authorizationOverlapped, true);
  assert.equal(maxActive, 6);
});

test("parallel gate pool reserves one CPU for authorization on small runners", async () => {
  const captured = [];
  let active = 0;
  let maxActive = 0;
  const result = await runManifestGatePlanParallel(
    [
      { id: "ontology-durable-action-authorization" },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `gate-${index}` })),
    ],
    {
      concurrency: 6,
      cpuCount: 2,
      execute: async (entry) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        captured.push(entry);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { ok: true };
      },
    },
  );

  assert.deepEqual(result.failedGateIds, []);
  assert.equal(maxActive, 1);
  assert.equal(
    captured.find((entry) => entry.id === "ontology-durable-action-authorization").authorizationAuditConcurrency,
    1,
  );
});

test("parallel gate pool exposes the auth cap only to the authorization child", async () => {
  const variable = "HARNESS_AUTH_AUDIT_CONCURRENCY";
  const previous = process.env[variable];
  const output = [];
  const originalLog = console.log;
  const originalError = console.error;
  delete process.env[variable];
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => output.push(args.join(" "));
  const command = `node -e "process.stdout.write('GATE_CAP=' + (process.env.${variable} || 'unset'))"`;
  try {
    const result = await runManifestGatePlanParallel(
      [
        { id: "ontology-durable-action-authorization", command },
        ...Array.from({ length: 5 }, (_, index) => ({ id: `other-${index}`, command })),
      ],
      { concurrency: 6, cpuCount: 8 },
    );
    assert.deepEqual(result.failedGateIds, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }

  assert.equal(output.filter((line) => line === "GATE_CAP=2").length, 1, output.join("\n"));
  assert.equal(output.filter((line) => line === "GATE_CAP=unset").length, 5, output.join("\n"));
});

test("manifest gate runner appends shard args only to shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "integration-shard", "--shard", "3"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 3" },
  ]);
});

test("manifest gate runner executes gates declared for non-pull-request workflow jobs", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["windows-integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "windows-integration-shard", "--shard", "4"]);
  options.eventName = "schedule";

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 4" },
  ]);
});

test("manifest gate runner fails when a workflow job selects zero gates on the firing event", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        executionSurfaces: { rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["windows-integration-shard"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "windows-integration-shard"]);
  options.eventName = "pull_request";

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    (error) => {
      assert.match(
        error.message,
        /workflow job "windows-integration-shard" selected 0 gates for event "pull_request"/u,
      );
      assert.match(error.message, /declared only in nonPullRequestJobs/u);
      return true;
    },
  );
});

test("manifest gate runner fails when no gate declares the workflow job on any surface", () => {
  const manifest = {
    gates: [
      {
        id: "check-existing",
        command: "node check-existing.mjs",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "no-such-job"]);
  options.eventName = "pull_request";

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    /no gate declares it in executionSurfaces\.rewriteCi or executionSurfaces\.prBody/u,
  );
});

test("manifest gate runner reports aggregate-only declarations instead of a bare empty plan", () => {
  const manifest = {
    gates: [
      {
        id: "aggregate-full-check",
        command: "npm run check",
        aggregate: true,
        executionSurfaces: { rewriteCi: { nonPullRequestJobs: ["nightly-soak"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "nightly-soak"]);
  options.eventName = "schedule";

  assert.throws(() => buildManifestGatePlan(manifest, options), /all 1 declaration\(s\) are aggregate gates/u);
});

test("manifest gate runner reports an exclusion that removes every gate", () => {
  const manifest = {
    gates: [
      {
        id: "check-example",
        command: "node check-example.mjs",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--exclude", "check-example"]);
  options.eventName = "pull_request";

  assert.throws(() => buildManifestGatePlan(manifest, options), /removed by --exclude/u);
});

test("manifest gate runner fails when --changed narrows a workflow job to zero changed paths", () => {
  const manifest = {
    gates: [
      {
        id: "check-docs",
        command: "node check-docs.mjs",
        localPathGlobs: ["docs-release/**"],
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.eventName = "pull_request";
  options.changedPaths = [];

  assert.throws(() => buildManifestGatePlan(manifest, options), /--changed origin\/main reported 0 changed paths/u);
});

test("every workflow job that invokes the manifest runner selects at least one gate", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "gate-manifest.json"), "utf8"));
  const workflow = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/rewrite-ci.yml"), "utf8");
  const jobNames = [...new Set([...workflow.matchAll(/--workflow-job\s+([A-Za-z0-9_-]+)/gu)].map((match) => match[1]))];

  assert.ok(jobNames.length > 0, "the workflow invokes the manifest runner");
  for (const jobName of jobNames) {
    const options = parseManifestGateArgs(["--workflow-job", jobName]);
    assert.ok(buildManifestGatePlan(manifest, options).length > 0, `${jobName} selected 0 gates`);
  }
});

test("manifest gate runner selects workflow gates for the current event surface", () => {
  const manifest = {
    gates: [
      {
        id: "lint",
        command: "npm run lint",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["crlf-checkout"], nonPullRequestJobs: ["crlf-checkout"] },
        },
      },
      {
        id: "test-fast",
        command: "npm run test:fast",
        executionSurfaces: { rewriteCi: { pullRequestJobs: [], nonPullRequestJobs: ["crlf-checkout"] } },
      },
    ],
  };
  const pullRequest = parseManifestGateArgs(["--workflow-job", "crlf-checkout"]);
  pullRequest.eventName = "pull_request";
  const schedule = parseManifestGateArgs(["--workflow-job", "crlf-checkout"]);
  schedule.eventName = "schedule";
  const push = parseManifestGateArgs(["--workflow-job", "crlf-checkout"]);
  push.eventName = "push";

  assert.deepEqual(buildManifestGatePlan(manifest, pullRequest), [{ id: "lint", command: "npm run lint" }]);
  assert.deepEqual(buildManifestGatePlan(manifest, schedule), [
    { id: "lint", command: "npm run lint" },
    { id: "test-fast", command: "npm run test:fast" },
  ]);
  assert.deepEqual(buildManifestGatePlan(manifest, push), buildManifestGatePlan(manifest, schedule));
});

test("manifest gate runner selects gates declared in the PR-body workflow", () => {
  const manifest = {
    gates: [
      {
        id: "pr-body-lint",
        command: "node tools/check-pr-body.mjs --env PR_BODY",
        executionSurfaces: { prBody: { pullRequestJobs: ["pr-body-lint"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "pr-body-lint"]);
  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "pr-body-lint", command: "node tools/check-pr-body.mjs --env PR_BODY" },
  ]);
});

test("manifest gate runner rejects --shard for non-shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "check-example",
        command: "npm run harness:check-example",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } },
      },
    ],
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--shard", "1"]);

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    /manifest gate check-example is not shardable but --shard was provided/u,
  );
});

test("manifest gate runner selects locally scoped gates for fully covered changed paths", () => {
  const manifest = selectionManifest();
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.changedPaths = ["docs-release/contributing/en/guide.md"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
  ]);
  assert.equal(options.changed, "origin/main");
});

test("manifest gate runner falls back to the full job when any changed path is unclassified", () => {
  const manifest = selectionManifest();
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--changed", "origin/main"]);
  options.changedPaths = ["docs-release/guide.md", "packages/kernel/src/index.ts"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
    { id: "check-everything", command: "node check-everything.mjs" },
  ]);
});

test("manifest gate runner preserves the full CI plan when --changed is absent", () => {
  const options = parseManifestGateArgs(["--workflow-job", "boundaries"]);

  assert.deepEqual(buildManifestGatePlan(selectionManifest(), options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
    { id: "check-everything", command: "node check-everything.mjs" },
  ]);
});

test("standalone changed mode derives its local PR gates from manifest path globs", () => {
  const manifest = selectionManifest();
  for (const gate of manifest.gates) {
    gate.deterministic = true;
    gate.executionSurfaces.classes = ["local", "pr"];
  }
  const options = parseManifestGateArgs(["--changed", "origin/main"]);
  options.changedPaths = ["docs-release/guide.md"];

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "check-docs", command: "node check-docs.mjs" },
    { id: "check-release", command: "node check-release.mjs" },
  ]);
});

test("standalone changed mode selects the standalone gate jobs' checks for the paths they read", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "gate-manifest.json"), "utf8"));
  const plan = (changedPaths) => {
    const options = parseManifestGateArgs(["--changed", "origin/main"]);
    options.changedPaths = changedPaths;
    return buildManifestGatePlan(manifest, options);
  };
  const cases = [
    ["entity-id-links", "node tools/gates/entity-id-links.mjs", "packages/gui/src/renderer/views/DecisionJudgeTab.tsx"],
    ["derived-contracts", "node tools/gates/derived-contracts.mjs --check", "tools/gates/contracts/gates.contract.mjs"],
    ["schema-closure", "node tools/gates/schema-closure.mjs --check", "packages/daemon/fixtures/contracts/x.json"],
    ["dependency-policy", "node tools/gates/dependency-policy.mjs", "package-lock.json"],
    ["cost-budget", "node tools/gates/cost-budget.mjs", "packages/storage/src/store/task-event-store.ts"],
  ];
  for (const [id, command, changedPath] of cases) {
    assert.ok(
      plan([changedPath]).some((entry) => entry.id === id && entry.command === command),
      `${id} selected by ${changedPath}`,
    );
  }
  const docsPlan = plan(["docs-release/guide.md"]);
  for (const [id] of cases)
    assert.equal(
      docsPlan.some((entry) => entry.id === id),
      false,
      `${id} skipped for docs`,
    );
});

test("standalone changed mode selects every cheap local gate for a path it checks and for its own checker", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "gate-manifest.json"), "utf8"));
  const scripts = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).scripts;
  // Whole-suite, packaging and platform gates stay off the stop path; CI runs them.
  const suiteGates = new Set([
    "typecheck",
    "test-fast",
    "test-contract",
    "test-integration",
    "test-gui",
    "smoke-cli-package",
    "check-package-tarball-exports",
    "windows-first-run",
  ]);
  // One path per gate that the gate reads; the first four are paths a local stop run once missed.
  const representativePaths = {
    "canonical-event-compat": "packages/daemon/src/daemon-host/protocol/readside-validator.ts",
    "check-write-coordinator-boundary": "packages/cli/src/new-command.ts",
    "check-write-road-registry": "packages/cli/src/new-command.ts",
    "check-file-complexity": "packages/application/src/commands/entity-action-catalog-executor.ts",
    "entity-id-links": "packages/gui/src/renderer/views/DecisionJudgeTab.tsx",
    "check-poll-spin-boundary": "packages/daemon/src/daemon-host/runtime-poll.ts",
    "check-fallback-boundaries": "tools/gates/receipt-verify.mjs",
    "check-entity-doc-contract": "packages/kernel/src/domain/entity-kind-registry.ts",
    "check-format": "packages/cli/src/index.ts",
    lint: "packages/cli/src/index.ts",
    "check-test-tier-manifest": "packages/storage/test/store/task-event-store.test.ts",
    "check-cli-structure": "packages/cli/src/new-command.ts",
    "check-cli-path-contract": "tools/check-cli-path-contract.mjs",
    "check-cli-help-contract": "packages/daemon/src/daemon-host/protocol/daemon-protocol.contract.ts",
    "check-cli-error-codes": "packages/cli/src/new-command.ts",
    "check-error-classification": "packages/cli/src/cli/thin-command.ts",
    "check-import-boundaries": "packages/daemon/package.json",
    "check-c4-architecture": "packages/daemon/package.json",
    "check-writer-isolate": "packages/daemon/src/writer-cell/repo-writer-worker.ts",
    "check-bypass-write-boundary": "packages/storage/src/store/task-event-store.ts",
    "check-kernel-dead-exports": "packages/daemon/src/daemon-host/repo-cell.ts",
    "check-relation-cycle-substrate": "packages/kernel/src/domain/relation-cycle.ts",
    "check-domain-judgment-single-definition": "packages/gui/src/renderer/task-adapter.ts",
    "check-relation-canonical-direction": "packages/daemon/src/daemon-host/repo-cell.ts",
    "check-task-event-aggregate-entry": "packages/application/src/task-lifecycle-service.ts",
    "scan-forbidden-symbols": "packages/gui/src/main.ts",
    "check-self-repo-path-literals": "packages/kernel/src/domain/gate-run.ts",
    "check-integrity-single-source": "packages/kernel/src/integrity/stable-hash.ts",
    "check-private-boundary": ".gitignore",
    "check-integration-test-shards": ".github/workflows/rewrite-ci.yml",
    "check-docs-release-map": "README.md",
    "check-gate-surface": ".github/branch-protection.md",
    "check-gate-manifest-invariants": "tools/gate-manifest.json",
    "authorization-provider-boundary": "tools/gates/authorization-provider-boundary.mjs",
    "check-template-command-surface": "packages/cli/src/cli/thin-command.ts",
    "check-locale-content": "packages/cli/src/cli/thin-command.ts",
    "check-catalog-schema": "packages/daemon/src/daemon-host/protocol/daemon-protocol.contract.ts",
    "check-runtime-release-readiness": "packages/kernel/src/domain/runtime-release-readiness.ts",
    "check-package-policy": "packages/cli/package.json",
    "check-implementation-contracts": "package-lock.json",
    "check-service-mappability": "packages/application/src/index.ts",
    "check-api-contract-registry": "packages/daemon/src/daemon-host/daemon-host.ts",
    "check-schema-contracts": "packages/kernel/fixtures/schemas/task-plan/valid.json",
    "check-schema-field-coverage": "packages/kernel/src/domain/entity-field-contracts.ts",
    "check-legacy-intake-readiness": "tools/legacy-intake/behavior-corpus-classification.json",
    "smoke-legacy-intake": "packages/cli/src/commands/migration.ts",
    "check-status-vocabulary": "packages/kernel/src/domain/status-vocabulary.ts",
    "check-sync-subprocess": "packages/daemon/src/daemon-host/repo-cell.ts",
    "derived-contracts": "tools/gates/contracts/gates.contract.mjs",
    "schema-closure": "packages/daemon/fixtures/contracts/x.json",
    "dependency-policy": "package-lock.json",
    "cost-budget": "packages/storage/src/store/task-event-store.ts",
  };
  const selectedIds = (changedPath) => {
    const options = parseManifestGateArgs(["--changed", "origin/main"]);
    options.changedPaths = [changedPath];
    return selectManifestGateIds(manifest, options);
  };
  const localGates = manifest.gates.filter(
    (gate) =>
      !gate.aggregate &&
      gate.deterministic === true &&
      gate.executionSurfaces?.classes?.includes("local") &&
      gate.executionSurfaces?.classes?.includes("pr") &&
      !suiteGates.has(gate.id),
  );

  assert.deepEqual(
    localGates.map((gate) => gate.id).sort(),
    Object.keys(representativePaths).sort(),
    "every cheap local gate names a representative path",
  );
  for (const gate of localGates) {
    assert.ok(selectedIds(representativePaths[gate.id]).includes(gate.id), `${gate.id} selected by its path`);
    const command = gate.command.replace(/^npm run (\S+)/u, (_, script) => scripts[script]);
    const checker = /^node (tools\/\S+\.mjs)/u.exec(command)?.[1];
    if (checker) assert.ok(selectedIds(checker).includes(gate.id), `${gate.id} selected by ${checker}`);
  }
  for (const id of suiteGates) assert.equal(selectedIds("packages/kernel/src/index.ts").includes(id), false, id);
});

test("test quarantine skips pull-request L0 jobs", () => {
  assert.equal(
    shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feature/x" }),
    true,
  );
  assert.equal(shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "pull_request" }), true);
  assert.equal(shouldSkipTestQuarantine("integration-shard", { GITHUB_EVENT_NAME: "schedule" }), false);
  assert.equal(
    shouldSkipTestQuarantine("windows-integration-shard", {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/x",
    }),
    false,
  );
});

test("manifest gate runner expands POSIX variables for the Windows shell only", () => {
  const env = { PR_BASE_SHA: "abc123", RUNNER_TEMP: "C:\\temp\\runner" },
    command = 'node gate.mjs --base "$PR_BASE_SHA" --body "${RUNNER_TEMP}\\pr-body.md"';
  assert.equal(
    commandForPlatformShell(command, { platform: "win32", env }),
    'node gate.mjs --base "abc123" --body "C:\\temp\\runner\\pr-body.md"',
  );
  assert.equal(
    commandForPlatformShell(command, { platform: "linux", env }),
    command,
    "the POSIX lanes keep the shell's own expansion",
  );
});

test("manifest gate runner leaves shell-owned and unknown variables alone on Windows", () => {
  const env = { PR_BASE_SHA: "abc123" },
    command = "sh -c 'echo $1 $@ $((1+2)) $UNSET_NAME' -- \"$PR_BASE_SHA\"";
  assert.equal(
    commandForPlatformShell(command, { platform: "win32", env }),
    "sh -c 'echo $1 $@ $((1+2)) $UNSET_NAME' -- \"abc123\"",
  );
});

function selectionManifest() {
  const executionSurfaces = { rewriteCi: { pullRequestJobs: ["boundaries"] } };
  return {
    gates: [
      {
        id: "check-docs",
        command: "node check-docs.mjs",
        localPathGlobs: ["README.md", "docs-release/**"],
        executionSurfaces,
      },
      {
        id: "check-release",
        command: "node check-release.mjs",
        localPathGlobs: ["docs-release/**"],
        executionSurfaces,
      },
      { id: "check-everything", command: "node check-everything.mjs", executionSurfaces },
    ],
  };
}
