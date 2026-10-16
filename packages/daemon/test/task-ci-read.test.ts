// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskCiFailure, readTaskCi, extractJobFailure } from "../src/task-ci-read.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol-commands.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fixture, sha, secret } from "./task-ci.fixtures.ts";
// Mirrors the raw job log of PR #3602 run 38376686123 job 116476680459: the S4 failure name, error
// and frames are verbatim from the CEO's authenticated pull (ci-red-e35ff75c.md); the surrounding
// runner format ([node-test-file], spec-reporter recap) is captured from a real local
// tools/run-node-tests.mjs failure, and each line carries GitHub's raw-log timestamp prefix.
const fleetCampaignJobLog =
  readFileSync(path.join(import.meta.dirname, "fixtures", "task-ci-fleet-campaign-job.log.txt"), "utf8") +
  `credential ${secret}\n`;
type ProviderCheck = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly details_url: string;
};
function provider(
  states = { status: "completed", conclusion: "failure" as string | null },
  checkRuns: readonly ProviderCheck[] = [],
  // Open pull requests for the branch; the empty default is the not_started "no PR" world.
  pulls: readonly { number: number; mergeable_state: string | null }[] = [],
) {
  const calls: string[][] = [];
  const run = async (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => {
    assert.equal(env.GH_TOKEN, secret);
    assert.equal(cwd, "/fixture/center");
    assert.equal(
      args.some((arg) => arg.includes(secret)),
      false,
    );
    calls.push([...args]);
    const endpoint = args.at(-1)!;
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo" });
    if (endpoint.endsWith("branches/task-ci")) return JSON.stringify({ commit: { sha } });
    if (endpoint.includes("pulls?")) return JSON.stringify(pulls);
    if (endpoint.includes("check-runs"))
      return JSON.stringify([
        {
          check_runs: [{ id: 101, name: `fast ${secret}`, ...states, details_url: "https://checks/1" }, ...checkRuns],
        },
        { check_runs: [] },
      ]);
    const base = {
      workflow_id: 11,
      run_attempt: 2,
      head_sha: sha,
      head_branch: "task-ci",
      event: "pull_request",
      ...states,
      html_url: "https://runs/2",
    };
    if (endpoint.includes("actions/runs?"))
      return JSON.stringify([
        {
          workflow_runs: [
            { ...base, id: 2 },
            { ...base, id: 1 },
            { ...base, id: 3, head_sha: "b".repeat(40) },
            { ...base, id: 4, head_branch: "task-other" },
            { ...base, id: 5, event: "workflow_dispatch" },
          ],
        },
      ]);
    if (endpoint.includes("/attempts/2/jobs"))
      return JSON.stringify([
        { jobs: [{ id: 21, name: "fast", ...states, html_url: "https://jobs/21" }] },
        {
          jobs: [{ id: 22, name: "contract", status: "completed", conclusion: "success", html_url: "https://jobs/22" }],
        },
      ]);
    if (args[0] === "api" && endpoint.includes("actions/jobs/21/logs")) return fleetCampaignJobLog;
    throw new Error(`Unexpected provider call ${args.join(" ")}`);
  };
  return { run, calls };
}

for (const role of ["implementation", "reviewer"] as const)
  test(`${role} reads only its current published SHA with failed files, names, errors and secret redaction`, async () => {
    const f = fixture(role),
      gh = provider(),
      receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, gh.run);
    assert.match(receipt.evidence!, /task-ci\/v2/u);
    assert.equal(receipt.ci.headSha, sha);
    assert.equal(receipt.ci.conclusion, "failure");
    assert.equal(receipt.ci.runs.length, 1);
    assert.equal(receipt.ci.runs[0]!.id, 2);
    assert.equal(receipt.ci.runs[0]!.jobs.length, 2);
    const failure = receipt.ci.runs[0]!.jobs[0]!.failure!;
    // The PR #3602 evidence: file, test name, error first line and frames straight from the raw log.
    assert.deepEqual(failure.testFiles, ["fail tools/stress/fleet-campaign.integration.test.mjs"]);
    assert.deepEqual(failure.tests, ["S4 exercises fleet claim, replica, takeover and injected-clock arms"]);
    assert.equal(failure.errors.length, 1);
    assert.equal(failure.errors[0]!.test, "S4 exercises fleet claim, replica, takeover and injected-clock arms");
    assert.equal(failure.errors[0]!.firstLine, "TypeError: Cannot read properties of undefined (reading 'length')");
    assert.deepEqual(failure.errors[0]!.frames, [
      "at runWorktreeSetup (packages/daemon/src/worktree-setup.ts:75:19)",
      "at prepareScheduleOccurrenceWorkspace (packages/daemon/src/schedule-occurrence-workspace.ts:200:22)",
      "at async occurrenceArm (tools/stress/fleet-campaign.integration.test.mjs:171:22)",
      "at async TestContext.<anonymous> (tools/stress/fleet-campaign.integration.test.mjs:57:19)",
    ]);
    assert.equal(failure.truncated, false);
    assert.equal(failure.logUrl, "https://jobs/21");
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.match(JSON.stringify(receipt), /REDACTED/u);
    assert.equal(gh.calls.filter((args) => args[0] === "api" && args.at(-1)!.includes("/logs")).length, 1);
    assert.deepEqual(
      gh.calls.find((args) => args[0] === "api" && args.at(-1)!.includes("/logs")),
      ["api", "--allow-escape-sequences", "repos/owner/repo/actions/jobs/21/logs"],
    );
    assert.equal(f.credentialReads(), 1);
  });

test("another task and a mismatched reviewer target remain visible to the CI reader", async () => {
  for (const role of ["implementation", "reviewer"] as const) {
    const f = fixture(role);
    await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-other" }, f.binding, provider().run);
    assert.equal(f.credentialReads(), 1);
  }
  const f = fixture("reviewer");
  f.dispatch.payload.reviewTarget.taskId = "task-other";
  await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, provider().run);
  assert.equal(f.credentialReads(), 1);
});

test("task CI reuses a report for the same branch and SHA, then refreshes immediately at a new head", async () => {
  const f = fixture();
  let currentSha = sha;
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const endpoint = args.at(-1)!;
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo" });
    if (endpoint.includes("branches/task-ci")) return JSON.stringify({ commit: { sha: currentSha } });
    if (endpoint.includes("check-runs")) return JSON.stringify([{ check_runs: [] }]);
    if (endpoint.includes("actions/runs?")) return JSON.stringify([{ workflow_runs: [] }]);
    if (endpoint.includes("pulls?")) return JSON.stringify([]);
    throw new Error(`Unexpected provider call ${endpoint}`);
  };
  const first = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, run);
  const second = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, run);
  assert.equal(first.ci.headSha, sha);
  assert.deepEqual(second.ci, first.ci);
  assert.equal(calls.filter((args) => args.at(-1)?.includes("branches/task-ci")).length, 2);
  assert.equal(calls.filter((args) => args.at(-1)?.includes("check-runs")).length, 1);
  currentSha = "b".repeat(40);
  const third = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, run);
  assert.equal(third.ci.headSha, currentSha);
  assert.equal(calls.filter((args) => args.at(-1)?.includes("check-runs")).length, 2);
});

test("only the newest run of a same-named check decides the verdict", async () => {
  // Two executions share one check name on the same SHA, listed in API order that differs per case:
  // only ordering by check-run id keeps the newest in both, so neither first-wins nor last-wins passes.
  for (const [listed, keptUrl, expected] of [
    [
      [
        {
          id: 700,
          name: "pr-body-lint",
          status: "completed",
          conclusion: "failure",
          details_url: "https://checks/700",
        },
        {
          id: 800,
          name: "pr-body-lint",
          status: "completed",
          conclusion: "success",
          details_url: "https://checks/800",
        },
      ],
      "https://checks/800",
      "success",
    ],
    [
      [
        {
          id: 804,
          name: "pr-body-lint",
          status: "completed",
          conclusion: "failure",
          details_url: "https://checks/804",
        },
        {
          id: 800,
          name: "pr-body-lint",
          status: "completed",
          conclusion: "success",
          details_url: "https://checks/800",
        },
      ],
      "https://checks/804",
      "failure",
    ],
  ] as const) {
    const f = fixture(),
      gh = provider({ status: "completed", conclusion: "success" }, [
        ...listed,
        { id: 900, name: "contract", status: "completed", conclusion: "success", details_url: "https://checks/900" },
      ]),
      receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, gh.run);
    assert.equal(receipt.ci.conclusion, expected);
    assert.equal(receipt.ci.checks.length, 3, "the superseded run is dropped; differently-named checks stay");
    const lint = receipt.ci.checks.find((check) => check.name === "pr-body-lint");
    assert.equal(lint?.url, keptUrl);
    assert.equal(lint?.conclusion, expected);
    assert.equal(gh.calls.filter((args) => args[0] === "api" && args.at(-1)!.includes("/logs")).length, 0);
  }
});

test("pending, successful and missing CI are distinct and no successful job fetches logs", async () => {
  for (const [status, conclusion, expected] of [
    ["queued", null, "pending"],
    ["completed", "success", "success"],
  ] as const) {
    const f = fixture(),
      gh = provider({ status, conclusion });
    const receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, gh.run);
    assert.equal(receipt.ci.conclusion, expected);
    assert.equal(gh.calls.filter((args) => args[0] === "api" && args.at(-1)!.includes("/logs")).length, 0);
  }
  const f = fixture(),
    gh = provider();
  const receipt = await readTaskCi(
    f.context as never,
    { kind: "task-ci", taskId: "task-ci" },
    f.binding,
    (args, env, cwd) =>
      args.at(-1)!.includes("per_page")
        ? Promise.resolve(args.at(-1)!.includes("check-runs") ? '[{"check_runs":[]}]' : '[{"workflow_runs":[]}]')
        : gh.run(args, env, cwd),
  );
  assert.equal(receipt.ci.conclusion, "not_started");
  // The empty default fixture has no open pull request, so the report names the actionable reason.
  assert.equal(receipt.ci.notStarted?.reason, "no_pull_request");
  assert.match(receipt.ci.notStarted?.detail ?? "", /ha task pr task-ci/u);
});

test("a not_started report distinguishes a conflicting PR, a missing PR, and queued registration", async () => {
  for (const [pulls, reason, detail] of [
    [
      [{ number: 7, mergeable_state: "dirty" }],
      "pull_request_conflict",
      /Pull request #7 for this branch conflicts with its base branch/u,
    ],
    [[], "no_pull_request", /No open pull request for branch task-ci/u],
    [[{ number: 8, mergeable_state: "clean" }], "queued", /GitHub may still be queuing them/u],
  ] as const) {
    const f = fixture(),
      gh = provider({ status: "completed", conclusion: "success" }, [], [...pulls]);
    const receipt = await readTaskCi(
      f.context as never,
      { kind: "task-ci", taskId: "task-ci" },
      f.binding,
      (args, env, cwd) =>
        args.at(-1)!.includes("per_page")
          ? Promise.resolve(args.at(-1)!.includes("check-runs") ? '[{"check_runs":[]}]' : '[{"workflow_runs":[]}]')
          : gh.run(args, env, cwd),
    );
    assert.equal(receipt.ci.conclusion, "not_started");
    assert.equal(receipt.ci.notStarted?.reason, reason);
    assert.match(receipt.ci.notStarted?.detail ?? "", detail);
    // The queued detail is the only one that tells the caller to keep waiting.
    if (reason === "queued") assert.match(receipt.ci.notStarted?.detail ?? "", /--wait/u);
  }
});

test("a report with checks never asks about pull requests", async () => {
  const f = fixture(),
    gh = provider();
  await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, gh.run);
  assert.equal(
    gh.calls.some((args) => args.some((arg) => String(arg).includes("pulls?"))),
    false,
  );
});

test("provider errors expose their failure code while removing the credential", async () => {
  const f = fixture();
  await assert.rejects(
    readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, async () => {
      throw new Error(`provider failed ${secret}`);
    }),
    (error: Error) =>
      !error.message.includes(secret) &&
      error.message.includes("[REDACTED]") &&
      (error as Error & { code: string }).code === "task_ci_read_failed",
  );
});

test("unbound callers and missing dispatch credentials never reach GitHub", async () => {
  const f = fixture();
  await assert.rejects(
    readTaskCi(
      f.context as never,
      { kind: "task-ci", taskId: "task-ci" },
      {
        actor: f.binding.actor,
        source: "local",
      },
      provider().run,
    ),
    { code: "actor_unauthorized" },
  );
  assert.equal(f.credentialReads(), 0);
  const context = { ...f.context, input: { prepareDaemonGitEnvironment: async () => null } };
  await assert.rejects(
    readTaskCi(context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, async () => {
      throw new Error("GitHub must not be called without the dispatch credential");
    }),
    { code: "runtime_credential_unavailable" },
  );
});

test("extraction reads the runner's own markers from a timestampless local log", () => {
  // Captured from a real local `node tools/run-node-tests.mjs --file <failing>` run: the inline ✖
  // carries no error; only the recap block does. No GitHub timestamp prefixes appear here.
  const result = extractJobFailure(
    "✖ runner file outcome fixture fails only when explicitly enabled (1.235417ms)\n" +
      "ℹ tests 1\nℹ fail 1\n\n✖ failing tests:\n\ntest at tools/test-fixtures/runner-file-outcomes/failing.test.mjs:5:1\n" +
      "✖ runner file outcome fixture fails only when explicitly enabled (1.235417ms)\n" +
      "  AssertionError [ERR_ASSERTION]: runner file outcome fixture assertion\n\n  1 !== 2\n\n" +
      "    at TestContext.<anonymous> (tools/test-fixtures/runner-file-outcomes/failing.test.mjs:7:10)\n" +
      "    at Test.runInAsyncScope (node:async_hooks:227:14)\n" +
      "[node-test-file] fail tools/test-fixtures/runner-file-outcomes/failing.test.mjs\n",
  );
  assert.deepEqual(result.tests, ["runner file outcome fixture fails only when explicitly enabled"]);
  assert.deepEqual(result.testFiles, ["fail tools/test-fixtures/runner-file-outcomes/failing.test.mjs"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.firstLine, "AssertionError [ERR_ASSERTION]: runner file outcome fixture assertion");
  assert.equal(result.errors[0]!.frames.length, 2);
  assert.match(result.errors[0]!.frames[0]!, /^at TestContext\.<anonymous>/u);
  assert.equal(result.truncated, false);
});

test("extraction bounds each failure to its error first line and five frames", () => {
  const frames = Array.from({ length: 7 }, (_, index) => `    at frame${index} (file.ts:${index}:1)`).join("\n");
  const result = extractJobFailure(
    `✖ deep failure\n  Error: boom\n${frames}\n[node-test-file] fail tools/x.test.mjs\n`,
  );
  assert.equal(result.errors[0]!.frames.length, 5);
  assert.match(result.errors[0]!.frames.at(-1)!, /frame4/u);
  assert.equal(result.truncated, true);
});

test("extraction reports truncation when failed tests or lines exceed their caps", () => {
  const many = Array.from({ length: 25 }, (_, index) => `✖ test ${index}`).join("\n");
  const byCount = extractJobFailure(many);
  assert.equal(byCount.tests.length, 20);
  assert.equal(byCount.truncated, true);
  const longLine = extractJobFailure(`✖ wide\n  ${"x".repeat(900)}\n`);
  assert.equal(longLine.errors[0]!.firstLine.length, 512);
  assert.equal(longLine.truncated, true);
});

test("a log without runner markers falls back to a short error excerpt, not a guess", () => {
  const result = extractJobFailure(
    "npm warn config\nRun supply-chain gate\n##[error]Process completed with exit code 1.\n",
  );
  assert.deepEqual(result.tests, []);
  assert.deepEqual(result.testFiles, []);
  assert.match(result.excerpt, /##\[error\]Process completed with exit code 1\./u);
  assert.equal(result.truncated, false);
});

test("only non-pass file outcomes count, across the runner's whole vocabulary", () => {
  const result = extractJobFailure(
    "[node-test-file] pass tools/a.test.mjs\n" +
      "[node-test-file] fail tools/b.test.mjs\n" +
      "[node-test-file] timeout tools/c.test.mjs\n" +
      "[node-test-file] incomplete tools/d.test.mjs\n",
  );
  assert.deepEqual(result.testFiles, [
    "fail tools/b.test.mjs",
    "timeout tools/c.test.mjs",
    "incomplete tools/d.test.mjs",
  ]);
});

test("an unreachable raw job log reports unavailability instead of an empty verdict", async () => {
  const f = fixture(),
    gh = provider();
  const receipt = await readTaskCi(
    f.context as never,
    { kind: "task-ci", taskId: "task-ci" },
    f.binding,
    async (args, env, cwd) => {
      const endpoint = args.at(-1)!;
      if (args[0] === "api" && endpoint.includes("actions/jobs/21/logs"))
        throw new Error(`gh: API HTTP 404 - Not Found (${secret})`);
      return gh.run(args, env, cwd);
    },
  );
  assert.equal(receipt.ci.conclusion, "failure");
  const failure = receipt.ci.runs[0]!.jobs[0]!.failure!;
  assert.match(failure.unavailable!, /raw job log unavailable/u);
  assert.match(failure.unavailable!, /404/u);
  assert.deepEqual(failure.tests, []);
  assert.equal(JSON.stringify(receipt).includes(secret), false);
});

test("CI command is a center-forwarded read, not a write or edge replica read", () => {
  const descriptor = commandDescriptorForAction("task-ci");
  assert.equal(descriptor.commandClass, "repo-read");
  assert.equal(descriptor.method, "repo.task.read");
  assert.equal(descriptor.admission["remote-edge"], "via-center-forward");
});

test("GitLab task CI reports the newest self-hosted pipeline and its failed job trace", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-ci-gitlab-")),
    previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    rmSync(rootDir, { recursive: true, force: true });
  });
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nsettings:\n  hosting:\n    provider: gitlab\n    host: gitlab.example.test\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", rootDir, "init", "--quiet"]);
  execFileSync("git", ["-C", rootDir, "remote", "add", "origin", "https://gitlab.example.test/group/project.git"]);
  const f = fixture(),
    calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("PRIVATE-TOKEN"), secret);
    if (url.includes("/repository/branches/")) return Response.json({ commit: { id: sha } });
    if (url.includes("/pipelines?"))
      return Response.json([
        { id: 10, status: "failed", ref: "task-ci", sha, web_url: "https://gitlab.example.test/pipelines/10" },
        { id: 9, status: "success", ref: "task-ci", sha, web_url: "https://gitlab.example.test/pipelines/9" },
      ]);
    if (url.includes("/pipelines/10/jobs"))
      return Response.json([
        { id: 101, name: "integration", status: "failed", web_url: "https://gitlab.example.test/jobs/101" },
      ]);
    if (url.includes("/jobs/101/trace"))
      return new Response(
        "✖ fleet trace arm fails (12.5ms)\n  Error: trace boom\n      at arm (tools/trace.test.mjs:9:1)\n" +
          `[node-test-file] fail tools/trace.test.mjs\ncredential ${secret}`,
        { status: 200 },
      );
    throw new Error(`Unexpected GitLab API call ${url}`);
  }) as typeof fetch;
  const context = {
    ...f.context,
    rootDir,
    input: {
      prepareDaemonGitEnvironment: async (_id: string, provider: string) =>
        provider === "gitlab" ? { GITLAB_TOKEN: secret } : null,
    },
  };
  const result = await readTaskCi(context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding);
  assert.equal(result.ci.conclusion, "failure");
  assert.equal(result.ci.runs[0]!.id, 10);
  assert.equal(result.ci.runs[0]!.jobs[0]!.failure!.tests[0], "fleet trace arm fails");
  assert.deepEqual(result.ci.runs[0]!.jobs[0]!.failure!.testFiles, ["fail tools/trace.test.mjs"]);
  assert.equal(result.ci.runs[0]!.jobs[0]!.failure!.errors[0]!.firstLine, "Error: trace boom");
  assert.equal(result.ci.runs[0]!.jobs[0]!.failure!.logUrl, "https://gitlab.example.test/jobs/101");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    calls.some((url) => url.includes("/projects/group%2Fproject/jobs/101/trace")),
    true,
  );
});

test("jobs for each latest workflow run are read concurrently and keep newest-first run order", async () => {
  const f = fixture();
  let inFlight = 0,
    peak = 0;
  const run = async (args: readonly string[]) => {
    const endpoint = args.at(-1)!;
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo" });
    if (endpoint.includes("branches/task-ci")) return JSON.stringify({ commit: { sha } });
    if (endpoint.includes("check-runs")) return JSON.stringify([{ check_runs: [] }]);
    const runOf = (id: number, workflow_id: number) => ({
      id,
      workflow_id,
      run_attempt: 1,
      head_sha: sha,
      head_branch: "task-ci",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      html_url: `https://runs/${id}`,
    });
    if (endpoint.includes("actions/runs?"))
      return JSON.stringify([{ workflow_runs: [runOf(7, 1), runOf(9, 2), runOf(8, 3)] }]);
    const match = /actions\/runs\/(\d+)\/attempts\/1\/jobs/u.exec(endpoint);
    if (match) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield across several turns so a serial reader would never observe two in flight.
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      const id = Number(match[1]);
      return JSON.stringify([
        { jobs: [{ id: id * 10, name: `job ${id}`, status: "completed", conclusion: "success", html_url: "u" }] },
      ]);
    }
    throw new Error(`Unexpected provider call ${endpoint}`);
  };
  const receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, run);
  assert.equal(peak, 3);
  assert.deepEqual(
    receipt.ci.runs.map((entry) => [entry.id, entry.jobs[0]!.id]),
    [
      [9, 90],
      [8, 80],
      [7, 70],
    ],
  );
  assert.equal(receipt.ci.conclusion, "success");
});

test("task CI reads bounded failure detail from the center observation cut without provider credentials", async () => {
  const f = fixture(),
    detailSha = "c".repeat(64),
    passingDetailSha = "d".repeat(64),
    detail = {
      schema: "ci-run-detail/v1",
      tests: [],
      fileOutcomes: [],
      diagnostics: [
        {
          kind: "ci-failure-excerpt",
          excerpt: "Error: gate failed\nerror TS2322: type mismatch",
        },
      ],
    },
    event = {
      schema: "ci-observation/read-v1",
      eventId: "event-task-ci",
      workspaceRevision: 7,
      opId: "ci-observation-task-ci",
      type: "ci_run_observed",
      actor: f.binding.actor,
      source: f.binding.source,
      occurredAt: "2026-10-12T00:00:00Z",
      payload: {
        scope: "job",
        identity: {
          provider: "github-actions",
          repositoryId: "owner/repo",
          workflow: "rewrite-ci",
          workflowPath: ".github/workflows/rewrite-ci.yml",
          workflowId: "11",
          databaseRunId: "2",
          runAttempt: 1,
          jobExecutionId: "21",
          jobKey: "21",
        },
        run: {
          runId: "2.1",
          sha,
          branch: "task-ci",
          prNumber: null,
          job: "fast-contract",
          wallclockMs: 0,
          runner: "github-actions",
        },
        verification: null,
        gates: [],
        measurementCoverage: {
          status: "unknown",
          missingReason: "derived from bounded provider log",
          startedFileCount: null,
          completedFileCount: null,
        },
        testSummary: null,
        failedTests: [],
        fileOutcomes: [],
        shardDurations: [],
        detailRef: {
          schema: "ci-run-detail/v1",
          sha256: detailSha,
          mediaType: "application/json",
          encoding: "identity",
          encodedBytes: 1,
          decodedBytes: 1,
        },
      },
    };
  const passingEvent = {
    ...event,
    eventId: "event-task-ci-passing",
    workspaceRevision: 6,
    opId: "ci-observation-task-ci-passing",
    payload: {
      ...event.payload,
      identity: { ...event.payload.identity, databaseRunId: "3", jobExecutionId: "22", jobKey: "22" },
      run: { ...event.payload.run, runId: "3.1", job: "contract" },
      detailRef: {
        ...event.payload.detailRef,
        sha256: passingDetailSha,
      },
    },
  };
  Object.assign(f.context.projection, {
    read: () => ({
      snapshot: {
        task: { iteration: 1 },
        executions: [{ iteration: 1, submission: { commitSha: sha } }],
      },
    }),
    readCiRunObservations: () => ({ status: "ready", events: [event, passingEvent], watermark: 7, sourceRevision: 7 }),
  });
  Object.assign(f.context, {
    store: {
      readContentBlob: (digest: string) =>
        digest === detailSha
          ? Buffer.from(JSON.stringify(detail))
          : digest === passingDetailSha
            ? Buffer.from(JSON.stringify({ schema: "ci-run-detail/v1", tests: [], fileOutcomes: [], diagnostics: [] }))
            : null,
    },
  });
  const receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, async () => {
    throw new Error("provider must not be called for center task CI reads");
  });
  assert.equal(receipt.ci.headSha, sha);
  assert.equal(receipt.ci.conclusion, "failure");
  assert.equal(receipt.ci.runs[0]!.jobs[0]!.failure?.excerpt, detail.diagnostics[0]!.excerpt);
  assert.equal(receipt.ci.runs[1]!.jobs[0]!.failure, null);
  assert.equal(f.credentialReads(), 0);
});

test("task CI reports pending while the center observation cut is not ready", async () => {
  const f = fixture();
  Object.assign(f.context.projection, {
    read: () => ({
      snapshot: {
        task: { iteration: 1 },
        executions: [{ iteration: 1, submission: { commitSha: sha } }],
      },
    }),
    readCiRunObservations: () => ({ status: "pending", events: [], watermark: 0, sourceRevision: 7 }),
  });
  Object.assign(f.context, { store: { readContentBlob: () => null } });
  const receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, async () => {
    throw new Error("provider must not be called for a pending center cut");
  });
  assert.equal(receipt.ci.conclusion, "pending");
  assert.equal(f.credentialReads(), 0);
});

test("submit-facing CI rejection detail names failed jobs and errors", () => {
  const detail = formatTaskCiFailure({
    schema: "task-ci/v2",
    taskId: "task-ci",
    branch: "task-ci",
    headSha: sha,
    conclusion: "failure",
    checks: [],
    runs: [
      {
        id: 91,
        attempt: 1,
        event: "push",
        status: "completed",
        conclusion: "failure",
        url: "",
        jobs: [
          {
            id: 910,
            name: "fast-contract",
            status: "completed",
            conclusion: "failure",
            url: "",
            failure: {
              testFiles: [],
              tests: ["branch test fails"],
              errors: [{ test: "branch test fails", firstLine: "Error: expected 1, got 2", frames: [] }],
              excerpt: "",
              truncated: false,
              logUrl: "",
            },
          },
        ],
      },
    ],
  });
  assert.match(detail, /failed job fast-contract/u);
  assert.match(detail, /failed tests: branch test fails/u);
  assert.match(detail, /error: Error: expected 1, got 2/u);
});
