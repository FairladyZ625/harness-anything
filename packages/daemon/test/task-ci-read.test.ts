// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readTaskCi, failureExcerpt } from "../src/task-ci-read.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol-commands.ts";

import { fixture, sha, secret } from "./task-ci.fixtures.ts";
function provider(states = { status: "completed", conclusion: "failure" as string | null }) {
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
    if (endpoint.includes("check-runs"))
      return JSON.stringify([
        { check_runs: [{ name: `fast ${secret}`, ...states, details_url: "https://checks/1" }] },
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

test("another task and a mismatched reviewer target are denied before resolving a credential", async () => {
  for (const role of ["implementation", "reviewer"] as const) {
    const f = fixture(role);
    await assert.rejects(
      readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-other" }, f.binding, provider().run),
      { code: "execution_credential_rejected" },
    );
    assert.equal(f.credentialReads(), 0);
  }
  const f = fixture("reviewer");
  f.dispatch.payload.reviewTarget.taskId = "task-other";
  await assert.rejects(
    readTaskCi(f.context as never, { kind: "task-ci", taskId: "task-ci" }, f.binding, provider().run),
    { code: "execution_credential_rejected" },
  );
  assert.equal(f.credentialReads(), 0);
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
  const context = { ...f.context, input: { prepareWorkerGitEnvironment: async () => null } };
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

test("CI command is a center-forwarded read, not a write or edge replica read", () => {
  const descriptor = commandDescriptorForAction("task-ci");
  assert.equal(descriptor.commandClass, "repo-read");
  assert.equal(descriptor.method, "repo.task.read");
  assert.equal(descriptor.admission["remote-edge"], "via-center-forward");
});
