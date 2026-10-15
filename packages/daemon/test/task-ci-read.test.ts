// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readTaskCi, failureExcerpt } from "../src/task-ci-read.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol-commands.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fixture, sha, secret } from "./task-ci.fixtures.ts";
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
    if (args[0] === "run")
      return `job step 2026-10-12 not ok 7 - task scope\nAssertionError: Expected 1\nactual: 2\nexpected: 1\ncredential ${secret}\n`;
    throw new Error(`Unexpected provider call ${args.join(" ")}`);
  };
  return { run, calls };
}

for (const role of ["implementation", "reviewer"] as const)
  test(`${role} reads only its current published SHA with failed names, assertions and secret redaction`, async () => {
    const f = fixture(role),
      gh = provider(),
      receipt = await readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, gh.run);
    assert.match(receipt.evidence!, /task-ci\/v1/u);
    assert.equal(receipt.ci.headSha, sha);
    assert.equal(receipt.ci.conclusion, "failure");
    assert.equal(receipt.ci.runs.length, 1);
    assert.equal(receipt.ci.runs[0]!.id, 2);
    assert.equal(receipt.ci.runs[0]!.jobs.length, 2);
    assert.match(
      receipt.ci.runs[0]!.jobs[0]!.failure!.excerpt,
      /not ok 7 - task scope\nAssertionError: Expected 1\nactual: 2/u,
    );
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.match(JSON.stringify(receipt), /REDACTED/u);
    assert.equal(gh.calls.filter((args) => args[0] === "run").length, 1);
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
    assert.equal(gh.calls.filter((args) => args[0] === "run").length, 0);
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
    assert.equal(gh.calls.filter((args) => args[0] === "run").length, 0);
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

test("large failed logs retain bounded assertion context and report truncation", () => {
  const result = failureExcerpt(`not ok 1 - boundary\nAssertionError: ${"x".repeat(20_000)}\nactual: 2`);
  assert.equal(result.excerpt.length, 8192);
  assert.equal(result.truncated, true);
  assert.match(result.excerpt, /not ok 1 - boundary/u);
});

test("failure excerpts deduplicate repeated failed test lines within the bound", () => {
  const result = failureExcerpt(
    "not ok 1 - repeated\nAssertionError: first\nnot ok 1 - repeated\nAssertionError: second",
  );
  assert.deepEqual(result.tests, ["not ok 1 - repeated"]);
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
    if (url.includes("/jobs/101/trace")) return new Response(`not ok 1 - failure\n${secret}`, { status: 200 });
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
  assert.equal(result.ci.runs[0]!.jobs[0]!.failure!.tests[0], "not ok 1 - failure");
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
