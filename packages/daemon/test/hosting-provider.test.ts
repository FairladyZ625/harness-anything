// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostingChecksFromGitHub, hostingProviderFromRemote, readHostingChecks } from "../src/hosting-provider.ts";

test("detects GitHub HTTPS and SSH remotes", () => {
  assert.deepEqual(hostingProviderFromRemote("https://github.com/acme/project.git"), {
    kind: "github",
    host: "github.com",
    repository: "acme/project",
  });
  assert.deepEqual(hostingProviderFromRemote("git@github.com:acme/project.git"), {
    kind: "github",
    host: "github.com",
    repository: "acme/project",
  });
});
test("detects a known provider when the repository has no authored settings file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-hosting-no-settings-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/project.git"]);
    const { detectHostingProvider } = await import("../src/hosting-provider.ts");
    assert.deepEqual(await detectHostingProvider(root), {
      kind: "github",
      host: "github.com",
      repository: "acme/project",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects self-hosted GitLab and encodes its REST base", () => {
  assert.deepEqual(
    hostingProviderFromRemote("ssh://git@git.example.test:2222/group/project.git", { provider: "gitlab" }),
    {
      kind: "gitlab",
      host: "git.example.test",
      projectPath: "group/project",
      apiBaseUrl: "https://git.example.test/api/v4",
    },
  );
});

test("explicit declaration resolves an unknown host and malformed remotes fail clearly", () => {
  assert.equal(
    hostingProviderFromRemote("https://code.example.test/group/project", {
      provider: "gitlab",
      host: "code.example.test",
    }).kind,
    "gitlab",
  );
  assert.throws(() => hostingProviderFromRemote("not-a-remote"), /hosting\.provider/u);
});

const pullUrl = "https://github.com/acme/project/pull/7";

test("github check rollup maps completed, pending, skipped, and status contexts", () => {
  const snapshot = hostingChecksFromGitHub({
    url: pullUrl,
    headRefOid: "abc123",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "gate",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: `${pullUrl}/checks`,
      },
      { __typename: "CheckRun", name: "shard", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
      { __typename: "CheckRun", name: "queued", status: "QUEUED", conclusion: null, detailsUrl: null },
      { __typename: "CheckRun", name: "matrix-skip", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null },
      { __typename: "CheckRun", name: "neutral", status: "COMPLETED", conclusion: "NEUTRAL", detailsUrl: null },
      {
        __typename: "CheckRun",
        name: "timed-job",
        status: "COMPLETED",
        conclusion: "TIMED_OUT",
        detailsUrl: "https://example.test/job",
      },
      { __typename: "StatusContext", context: "commit-status", state: "SUCCESS", targetUrl: null },
      { __typename: "StatusContext", context: "pending-status", state: "PENDING", targetUrl: null },
      { __typename: "StatusContext", context: "broken-status", state: "FAILURE", targetUrl: "https://example.test/ci" },
      { __typename: "SomethingNew", name: "mystery" },
    ],
  });
  assert.equal(snapshot.subjectUrl, pullUrl);
  assert.equal(snapshot.headSha, "abc123");
  const stateOf = (name: string) => snapshot.checks.find((check) => check.name === name)?.state;
  assert.equal(stateOf("gate"), "passed");
  assert.equal(stateOf("shard"), "pending");
  assert.equal(stateOf("queued"), "pending");
  assert.equal(stateOf("matrix-skip"), "skipped");
  assert.equal(stateOf("neutral"), "skipped");
  assert.deepEqual(
    snapshot.checks.find((check) => check.name === "timed-job"),
    { name: "timed-job", state: "failed", url: "https://example.test/job" },
  );
  assert.equal(stateOf("commit-status"), "passed");
  assert.equal(stateOf("pending-status"), "pending");
  assert.equal(stateOf("broken-status"), "failed");
  // An unknown rollup entry claims no verdict: it waits, it never fakes green.
  assert.equal(stateOf("mystery"), "pending");
});

test("github checks read through gh and classify a missing pull request", async () => {
  let args: readonly string[] = [];
  const snapshot = await readHostingChecks(
    hostingProviderFromRemote("https://github.com/acme/project.git"),
    {
      branch: "task-x",
      env: { GH_TOKEN: "opaque-github-secret" },
      cwd: "/fixture/center",
    },
    {
      runProvider: async (received, env) => {
        args = received;
        assert.equal(env.GH_TOKEN, "opaque-github-secret");
        return JSON.stringify({ url: pullUrl, headRefOid: "def456", statusCheckRollup: [] });
      },
    },
  );
  assert.deepEqual(args.slice(0, 4), ["pr", "view", "task-x", "--json"]);
  assert.match(String(args[4]), /statusCheckRollup/u);
  assert.equal(snapshot.headSha, "def456");
  await assert.rejects(
    readHostingChecks(
      hostingProviderFromRemote("https://github.com/acme/project.git"),
      {
        branch: "task-x",
        env: {},
        cwd: "/fixture/center",
      },
      {
        runProvider: async () => {
          throw new Error("no pull requests found for branch task-x");
        },
      },
    ),
    (error: Error & { code?: string }) =>
      error.code === "ci_pull_request_missing" && error.message.includes("no pull requests found"),
  );
});

type FakeGitLabResponse = { readonly status: number; readonly body: unknown; readonly nextPage: string | null };

test("gitlab checks read the merge request pipeline jobs across pages", async () => {
  const calls: string[] = [],
    mergeRequest = {
      iid: 12,
      sha: "gitlab-head",
      web_url: "https://git.example.test/group/project/-/merge_requests/12",
      project_id: 88,
      head_pipeline: {
        id: 4021,
        status: "running",
        web_url: "https://git.example.test/group/project/-/pipelines/4021",
      },
    };
  const fetchJson = async (url: string): Promise<FakeGitLabResponse> => {
    calls.push(url);
    if (url.includes("/merge_requests?")) return { status: 200, body: [mergeRequest], nextPage: null };
    if (url.includes("/pipelines/4021/jobs?") && url.includes("page=2"))
      return {
        status: 200,
        nextPage: null,
        body: [{ name: "docs", status: "manual", web_url: null, allow_failure: false }],
      };
    if (url.includes("/pipelines/4021/jobs?"))
      return {
        status: 200,
        nextPage: "2",
        body: [
          { name: "unit", status: "success", web_url: "https://git.example.test/jobs/1", allow_failure: false },
          {
            name: "integration-shard",
            status: "failed",
            web_url: "https://git.example.test/jobs/2",
            allow_failure: false,
          },
          { name: "flaky", status: "failed", web_url: null, allow_failure: true },
          { name: "lint", status: "running", web_url: null, allow_failure: false },
        ],
      };
    throw new Error(`unexpected gitlab call ${url}`);
  };
  const snapshot = await readHostingChecks(
    hostingProviderFromRemote("git@git.example.test:group/project.git", {
      provider: "gitlab",
      host: "git.example.test",
    }),
    { branch: "task-x", env: { GITLAB_TOKEN: "opaque-gitlab-secret" }, cwd: "/fixture/center" },
    { fetchJson },
  );
  assert.equal(calls[0]?.includes(encodeURIComponent("group/project")), true);
  assert.equal(calls[0]?.includes("source_branch=task-x"), true);
  assert.equal(calls[0]?.includes("state=opened"), true);
  assert.equal(snapshot.subjectUrl, mergeRequest.web_url);
  assert.equal(snapshot.headSha, "gitlab-head");
  const stateOf = (name: string) => snapshot.checks.find((check) => check.name === name)?.state;
  assert.equal(stateOf("unit"), "passed");
  assert.deepEqual(
    snapshot.checks.find((check) => check.name === "integration-shard"),
    {
      name: "integration-shard",
      state: "failed",
      url: "https://git.example.test/jobs/2",
    },
  );
  assert.equal(stateOf("flaky"), "skipped");
  assert.equal(stateOf("lint"), "pending");
  assert.equal(stateOf("docs"), "skipped");
});

test("gitlab checks report a pipeline-less merge request as pending and fail clearly on gaps", async () => {
  const fetchJson = async (url: string): Promise<FakeGitLabResponse> =>
    url.includes("/merge_requests?")
      ? {
          status: 200,
          nextPage: null,
          body: [
            {
              iid: 13,
              sha: "no-pipeline",
              web_url: "https://git.example.test/group/project/-/merge_requests/13",
              project_id: 88,
              head_pipeline: null,
            },
          ],
        }
      : await Promise.reject(new Error("no jobs call expected"));
  const snapshot = await readHostingChecks(
    hostingProviderFromRemote("git@git.example.test:group/project.git", {
      provider: "gitlab",
      host: "git.example.test",
    }),
    { branch: "task-x", env: { GITLAB_TOKEN: "tokenless-probe" }, cwd: "/fixture/center" },
    { fetchJson },
  );
  assert.deepEqual(snapshot.checks, []);
  const provider = hostingProviderFromRemote("git@git.example.test:group/project.git", {
    provider: "gitlab",
    host: "git.example.test",
  });
  await assert.rejects(
    readHostingChecks(
      provider,
      { branch: "task-x", env: { GITLAB_TOKEN: "tokenless-probe" }, cwd: "/fixture/center" },
      {
        fetchJson: async () => ({ status: 200, nextPage: null, body: [] }),
      },
    ),
    (error: Error & { code?: string }) => error.code === "ci_pull_request_missing",
  );
  await assert.rejects(
    readHostingChecks(
      provider,
      { branch: "task-x", env: { GITLAB_TOKEN: "tokenless-probe" }, cwd: "/fixture/center" },
      {
        fetchJson: async () => ({ status: 401, nextPage: null, body: { message: "401 Unauthorized" } }),
      },
    ),
    (error: Error & { code?: string }) => error.code === "hosting_checks_unavailable" && error.message.includes("401"),
  );
  await assert.rejects(
    readHostingChecks(
      provider,
      { branch: "task-x", env: {}, cwd: "/fixture/center" },
      {
        fetchJson: async () => ({ status: 200, nextPage: null, body: [] }),
      },
    ),
    (error: Error & { code?: string }) =>
      error.code === "hosting_checks_unavailable" && error.message.includes("No GitLab token"),
  );
});
