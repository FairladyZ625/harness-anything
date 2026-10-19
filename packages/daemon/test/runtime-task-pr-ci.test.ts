// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  waitTaskPullRequestChecks,
  waitCiDefaultTimeoutMinutes,
  waitCiPollIntervalMs,
} from "../src/runtime-task-pr.ts";
import {
  readHostingChecks,
  type HostingChecksQuery,
  type HostingChecksSnapshot,
  type HostingProvider,
} from "../src/hosting-provider.ts";
import { fixture, secret } from "./runtime-task-pr.fixtures.ts";

const github = (repository = "fixture/repo"): HostingProvider => ({
  kind: "github",
  host: "github.com",
  repository,
});

const gitlab = (): HostingProvider => ({
  kind: "gitlab",
  host: "git.example.test",
  projectPath: "group/project",
  apiBaseUrl: "https://git.example.test/api/v4",
});

type ScriptedPort = {
  readonly port: (
    provider: HostingProvider,
    query: { readonly branch: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<HostingChecksSnapshot>;
  readonly calls: { readonly provider: HostingProvider; readonly branch: string; readonly env: NodeJS.ProcessEnv }[];
};

function scriptedPort(responses: readonly (HostingChecksSnapshot | Error)[]): ScriptedPort {
  const calls: ScriptedPort["calls"] = [],
    queue = [...responses];
  return {
    calls,
    port: async (provider, query) => {
      calls.push({ provider, branch: query.branch, env: query.env });
      // The script advances until one answer remains, which repeats: a wait that polls past the
      // script exercises the same steady state instead of inventing a new one.
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error("scripted port has no answers");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** A fake clock: delay advances it by one poll interval, so the wait loop never sleeps for real. */
function fakeClock() {
  let now = 0,
    ticks = 0;
  return {
    nowMs: () => now,
    ticks: () => ticks,
    waitCiDelay: async (ms: number) => {
      assert.equal(ms, waitCiPollIntervalMs);
      ticks += 1;
      now += ms;
    },
  };
}

function waitContext(
  overrides: {
    readonly credential?: NodeJS.ProcessEnv | null;
    readonly provider?: "github" | "gitlab";
  } = {},
) {
  const f = fixture(),
    credential = overrides.credential !== undefined ? overrides.credential : { GH_TOKEN: secret };
  const context = {
    ...f.context,
    store: { readHead: () => ({ revision: 42 }) },
    withHumanSummary: (receipt: unknown) => receipt,
    input: {
      prepareDaemonGitEnvironment: async (id: string, provider: string) => {
        assert.equal(id, "instance-pr");
        assert.equal(provider, overrides.provider ?? "github");
        return credential;
      },
    },
  };
  return { context, binding: f.binding };
}

const prUrl = "https://github.com/fixture/repo/pull/9";

const pendingSnapshot: HostingChecksSnapshot = {
  subjectUrl: prUrl,
  headSha: "head-1",
  checks: [{ name: "integration-shard", state: "pending", url: null }],
};

const greenSnapshot: HostingChecksSnapshot = {
  subjectUrl: prUrl,
  headSha: "head-1",
  checks: [
    { name: "lint", state: "passed", url: null },
    { name: "fast", state: "passed", url: null },
    { name: "docs", state: "skipped", url: null },
  ],
};

test("wait-ci reports green in one line after a pending poll turns terminal", async () => {
  const scripted = scriptedPort([pendingSnapshot, greenSnapshot]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    binding,
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly summary: string; readonly evidence: string };
  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.summary, "all green (2 pass, 1 skipped)");
  assert.equal(receipt.evidence, prUrl);
  assert.equal(scripted.calls.length, 2);
  assert.equal(clock.ticks(), 1);
  assert.equal(scripted.calls[0]?.branch, "task-pr");
  assert.equal(scripted.calls[0]?.env.GH_TOKEN, secret);
  assert.deepEqual(scripted.calls[0]?.provider, github());
});

test("wait-ci reports red with the failing check names and exits failed", async () => {
  const scripted = scriptedPort([
      {
        subjectUrl: prUrl,
        headSha: "head-1",
        checks: [
          { name: "lint", state: "passed", url: null },
          { name: "integration-shard", state: "failed", url: "https://github.com/fixture/repo/actions/runs/6/job/9" },
        ],
      },
    ]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    binding,
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly code: string; readonly exitCode: number; readonly summary: string };
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "ci_checks_failed");
  assert.equal(receipt.exitCode, 1);
  assert.match(receipt.summary, /failed: integration-shard \(1 failed\)/u);
  assert.match(receipt.summary, /actions\/runs\/6\/job\/9/u);
  assert.equal(scripted.calls.length, 1);
  assert.equal(clock.ticks(), 0);
});

test("wait-ci times out with the pending count and never polls past its deadline", async () => {
  const scripted = scriptedPort([pendingSnapshot]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true, timeoutMinutes: 1 },
    binding,
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly code: string; readonly exitCode: number; readonly summary: string };
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "ci_wait_timeout");
  assert.equal(receipt.exitCode, 2);
  assert.match(receipt.summary, /timeout after 1 minute/u);
  assert.match(receipt.summary, /1 check still pending/u);
  assert.match(receipt.summary, new RegExp(prUrl.replace(/\//gu, "\\$&"), "u"));
  // One-minute deadline at a 15s interval: the initial poll plus polls at 15s/30s/45s, then the
  // 60s read sees the deadline reached — the loop must not sleep past the answer it already has.
  assert.equal(scripted.calls.length, 5);
  assert.equal(clock.ticks(), 4);
});

test("wait-ci holds a zero-check GitHub snapshot until the checks register", async () => {
  // The false-green race from review dispatch_cb7adce3ad7786321c63541a: `ha task pr` returns
  // before GitHub registers any check run, and the first read folds `statusCheckRollup: []` into
  // an empty list that must wait, not report green.
  let reads = 0;
  const port = (provider: HostingProvider, query: HostingChecksQuery) =>
      readHostingChecks(provider, query, {
        runProvider: async () =>
          JSON.stringify({
            url: prUrl,
            headRefOid: "head-1",
            statusCheckRollup:
              reads++ === 0
                ? []
                : [
                    {
                      __typename: "CheckRun",
                      name: "gate",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      detailsUrl: null,
                    },
                  ],
          }),
      }),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    binding,
    { hosting: github(), readChecks: port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly summary: string };
  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.summary, "all green (1 pass, 0 skipped)");
  assert.equal(reads, 2);
  assert.equal(clock.ticks(), 1);
});

test("wait-ci times out naming the missing registration when no GitHub check ever appears", async () => {
  let reads = 0;
  const port = (provider: HostingProvider, query: HostingChecksQuery) =>
      readHostingChecks(provider, query, {
        runProvider: async () => {
          reads += 1;
          return JSON.stringify({ url: prUrl, headRefOid: "head-1", statusCheckRollup: [] });
        },
      }),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true, timeoutMinutes: 1 },
    binding,
    { hosting: github(), readChecks: port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly code: string; readonly exitCode: number; readonly summary: string };
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "ci_wait_timeout");
  assert.equal(receipt.exitCode, 2);
  assert.match(receipt.summary, /timeout after 1 minute: no checks registered for the head/u);
  assert.doesNotMatch(receipt.summary, /checks still pending/u);
  assert.equal(reads, 5);
  assert.equal(clock.ticks(), 4);
});

test("wait-ci times out on a pipeline-less GitLab merge request instead of reading it green", async () => {
  const mergeRequest = {
      iid: 14,
      sha: "gitlab-head",
      web_url: "https://git.example.test/group/project/-/merge_requests/14",
      head_pipeline: null,
    },
    mrUrl = mergeRequest.web_url;
  let reads = 0;
  const port = (provider: HostingProvider, query: HostingChecksQuery) =>
      readHostingChecks(provider, query, {
        fetchJson: async (url: string) => {
          // A pipeline-less merge request answers the lookup only; no jobs page exists to read.
          assert.match(url, /\/merge_requests\?/u);
          reads += 1;
          return { status: 200, body: [mergeRequest], nextPage: null };
        },
      }),
    clock = fakeClock(),
    { context, binding } = waitContext({ credential: { GITLAB_TOKEN: secret }, provider: "gitlab" });
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true, timeoutMinutes: 1 },
    binding,
    { hosting: gitlab(), readChecks: port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly code: string; readonly summary: string };
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "ci_wait_timeout");
  assert.match(receipt.summary, /no checks registered for the head/u);
  assert.match(receipt.summary, new RegExp(mrUrl.replace(/\//gu, "\\$&"), "u"));
  assert.equal(reads, 5);
});

test("wait-ci default timeout is the constant, not a setting", async () => {
  const scripted = scriptedPort([pendingSnapshot]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    binding,
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly summary: string };
  assert.match(receipt.summary, /timeout after 60 minutes/u);
  assert.equal(scripted.calls.length, (waitCiDefaultTimeoutMinutes * 60_000) / waitCiPollIntervalMs + 1);
});

test("wait-ci fails fast when no pull request exists for the task branch", async () => {
  const missing = Object.assign(new Error("no pull requests found for branch task-pr"), {
      code: "ci_pull_request_missing",
    }),
    scripted = scriptedPort([missing]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  await assert.rejects(
    waitTaskPullRequestChecks(context as never, { kind: "task-pr", taskId: "task-pr", waitCi: true }, binding, {
      hosting: github(),
      readChecks: scripted.port,
      waitCiDelay: clock.waitCiDelay,
      nowMs: clock.nowMs,
    }),
    (error: Error & { code?: string }) => error.code === "ci_pull_request_missing",
  );
  assert.equal(clock.ticks(), 0);
});

test("wait-ci rethrows a vanished pull request instead of waiting out the clock", async () => {
  const missing = Object.assign(new Error("no pull requests found for branch task-pr"), {
      code: "ci_pull_request_missing",
    }),
    scripted = scriptedPort([pendingSnapshot, missing]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  await assert.rejects(
    waitTaskPullRequestChecks(context as never, { kind: "task-pr", taskId: "task-pr", waitCi: true }, binding, {
      hosting: github(),
      readChecks: scripted.port,
      waitCiDelay: clock.waitCiDelay,
      nowMs: clock.nowMs,
    }),
    (error: Error & { code?: string }) => error.code === "ci_pull_request_missing",
  );
});

test("wait-ci rides out a transient read failure inside the same budget", async () => {
  const scripted = scriptedPort([pendingSnapshot, new Error("socket hang up"), greenSnapshot]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    binding,
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string };
  assert.equal(receipt.outcome, "applied");
  assert.equal(scripted.calls.length, 3);
});

test("wait-ci names the last read error when the budget expires without a verdict", async () => {
  const scripted = scriptedPort([pendingSnapshot, new Error("502 from the provider")]),
    clock = fakeClock(),
    { context, binding } = waitContext();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true, timeoutMinutes: 1 },
    binding,
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly summary: string };
  assert.match(receipt.summary, /last read error: 502 from the provider/u);
});

test("wait-ci refuses a worker without a hosting credential before reading anything", async () => {
  const scripted = scriptedPort([greenSnapshot]),
    clock = fakeClock(),
    { context, binding } = waitContext({ credential: null });
  await assert.rejects(
    waitTaskPullRequestChecks(context as never, { kind: "task-pr", taskId: "task-pr", waitCi: true }, binding, {
      hosting: github(),
      readChecks: scripted.port,
      waitCiDelay: clock.waitCiDelay,
      nowMs: clock.nowMs,
    }),
    (error: Error & { code?: string }) =>
      error.code === "runtime_credential_unavailable" && error.message.includes("hosting-credential set"),
  );
  assert.equal(scripted.calls.length, 0);
});

test("wait-ci supports GitLab with the daemon-held GITLAB_TOKEN", async () => {
  const scripted = scriptedPort([greenSnapshot]),
    clock = fakeClock(),
    { context, binding } = waitContext({ credential: { GITLAB_TOKEN: secret }, provider: "gitlab" });
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    binding,
    { hosting: gitlab(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string };
  assert.equal(receipt.outcome, "applied");
  assert.equal(scripted.calls[0]?.env.GITLAB_TOKEN, secret);
  assert.deepEqual(scripted.calls[0]?.provider, gitlab());
});

test("wait-ci for a human principal uses ambient repository authentication", async () => {
  const f = fixture();
  let prepared = false;
  const context = {
    ...f.context,
    store: { readHead: () => ({ revision: 42 }) },
    withHumanSummary: (receipt: unknown) => receipt,
    input: {
      prepareDaemonGitEnvironment: async () => {
        prepared = true;
        throw new Error("human wait must not resolve an execution instance credential");
      },
    },
  };
  const scripted = scriptedPort([greenSnapshot]),
    clock = fakeClock();
  const receipt = (await waitTaskPullRequestChecks(
    context as never,
    { kind: "task-pr", taskId: "task-pr", waitCi: true },
    { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" },
    { hosting: github(), readChecks: scripted.port, waitCiDelay: clock.waitCiDelay, nowMs: clock.nowMs },
  )) as { readonly outcome: string; readonly summary: string };
  assert.equal(prepared, false);
  assert.equal(receipt.outcome, "applied");
});
