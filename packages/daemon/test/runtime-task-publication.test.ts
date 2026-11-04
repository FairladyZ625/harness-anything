// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { SubmissionV1, TaskProjection } from "@harness-anything/kernel";
import { publishTaskWorkerBranch } from "../src/runtime-task-publication.ts";
import {
  deliveryProjection,
  workerSettlementRuntime,
  workerSettlementContext,
  fixtureTaskId,
  git,
  workerGitFixture,
} from "./runtime-spawn-settlement.fixtures.ts";

const frozen = (commitSha: string): SubmissionV1 => ({
  commitSha,
  completionClaim: "Frozen delivery summary.",
  verificationNotes: ["Targeted tests passed."],
  residualRisks: ["External CI pending."],
  knownGaps: [],
  deliverables: [],
  outputs: [],
  changedFiles: ["change.txt"],
  completionContract: {} as never,
});

const frozenFacts = (commitSha: string, added: number, deleted: number): SubmissionV1 => ({
  ...frozen(commitSha),
  productionDelta: {
    baseSha: "b".repeat(40),
    added,
    deleted,
    changed: [],
    unclassified: [],
  },
});

const factsBody = (commitSha: string, added: number, deleted: number): string =>
  [
    "# Pull request",
    "",
    "Authored summary stays.",
    "",
    "<!-- harness:submission-facts:start -->",
    "## Delivery Facts",
    `- Delivery commit: \`${commitSha}\``,
    `- Merge base: \`${"b".repeat(40)}\``,
    `- Production delta: +${String(added)}/-${String(deleted)} (net +${String(added - deleted)}).`,
    "<!-- harness:submission-facts:end -->",
    "",
    "Authored tail stays.",
  ].join("\n");

test("publication creates then updates one PR for the submitted branch using daemon credentials", async (context) => {
  const fixture = workerGitFixture(context, "publication", { reachableRemote: true }),
    head = git(fixture.worker, "rev-parse", "HEAD").trim(),
    requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  let exists = false;
  context.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    assert.equal(
      git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(),
      head,
      "the branch is pushed before the hosting write",
    );
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer daemon-only-fixture");
    const method = options.method ?? "GET";
    requests.push({ url: String(url), method, body: options.body ? JSON.parse(String(options.body)) : null });
    if (method === "GET" && !String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if (method === "GET")
      return Response.json(exists ? [{ number: 42, html_url: "https://github.com/acme/repo/pull/42" }] : []);
    exists = true;
    return Response.json({ number: 42, html_url: "https://github.com/acme/repo/pull/42" });
  });
  const input = {
    cwd: fixture.worker,
    canonicalRoot: fixture.canonical,
    taskId: fixtureTaskId,
    submittedCommitSha: head,
    env: { GH_TOKEN: "daemon-only-fixture" },
    pullRequest: {
      hosting: { kind: "github" as const, host: "github.com", repository: "acme/repo" },
      taskTitle: "Delivered task",
      submission: frozen(head),
      title: "Explicit PR title",
      body: "Repository-owned body.\n\nLiteral `$()`.",
    },
  };
  await publishTaskWorkerBranch(input);
  const { body: explicitBody, title: explicitTitle, ...defaults } = input.pullRequest;
  await publishTaskWorkerBranch({ ...input, pullRequest: { ...defaults, title: explicitTitle } });
  await publishTaskWorkerBranch({ ...input, pullRequest: { ...defaults, body: explicitBody } });
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "GET", "POST", "GET", "GET", "PATCH", "GET", "GET", "PATCH"],
  );
  assert.match(requests[1]!.url, new RegExp(`head=acme%3A${fixtureTaskId}`, "u"));
  assert.equal(requests[2]!.body?.head, fixtureTaskId);
  assert.equal(requests[2]!.body?.title, explicitTitle);
  assert.equal(requests[2]!.body?.body, explicitBody);
  assert.deepEqual(requests[5]!.body, { title: explicitTitle });
  assert.deepEqual(requests[8]!.body, { body: explicitBody });
});

function publicationFixture(context: Parameters<typeof workerGitFixture>[0], slug: string) {
  const fixture = workerGitFixture(context, slug, { reachableRemote: true }),
    head = git(fixture.worker, "rev-parse", "HEAD").trim();
  return {
    fixture,
    input: {
      cwd: fixture.worker,
      canonicalRoot: fixture.canonical,
      taskId: fixtureTaskId,
      submittedCommitSha: head,
      env: { GH_TOKEN: "daemon-only-fixture" },
      pullRequest: {
        hosting: { kind: "github" as const, host: "github.com", repository: "acme/repo" },
        taskTitle: "Delivered task",
        submission: frozen(head),
      },
    },
  };
}

test("a reworked push refreshes the machine delivery facts and keeps authored prose", async (context) => {
  const fixture = workerGitFixture(context, "publication-facts", { reachableRemote: true }),
    first = git(fixture.worker, "rev-parse", "HEAD").trim(),
    requests: { method: string; body: Record<string, unknown> | null }[] = [];
  let existing: Record<string, unknown> | undefined;
  context.mock.method(globalThis, "fetch", async (_url: string | URL, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    if (method === "GET" && !String(_url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if (method === "GET") return Response.json(existing ? [existing] : []);
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    requests.push({ method, body });
    existing = { number: 42, html_url: "https://github.com/acme/repo/pull/42", ...body };
    return Response.json(existing);
  });
  const input = {
      cwd: fixture.worker,
      canonicalRoot: fixture.canonical,
      taskId: fixtureTaskId,
      env: { GH_TOKEN: "daemon-only-fixture" },
      pullRequest: {
        hosting: { kind: "github" as const, host: "github.com", repository: "acme/repo" },
        taskTitle: "Delivered task",
        submission: frozenFacts(first, 71, 30),
        body: factsBody(first, 71, 30),
      },
    },
    initial = input.pullRequest.submission;
  await publishTaskWorkerBranch({ ...input, submittedCommitSha: first });
  writeFileSync(path.join(fixture.worker, "rework.txt"), "reworked\n");
  git(fixture.worker, "add", "rework.txt");
  git(fixture.worker, "commit", "--quiet", "-m", "fix: rework the cut");
  const second = git(fixture.worker, "rev-parse", "HEAD").trim(),
    reworked = frozenFacts(second, 322, 56);
  await publishTaskWorkerBranch({
    ...input,
    submittedCommitSha: second,
    pullRequest: { ...input.pullRequest, submission: reworked, body: undefined },
  });
  assert.notEqual(second, first);
  assert.match(String(requests[0]!.body?.body), new RegExp(`Delivery commit: \\x60${initial.commitSha}\\x60`, "u"));
  assert.match(String(requests[0]!.body?.body), /Production delta: \+71\/-30/u);
  assert.match(String(requests[1]!.body?.body), new RegExp(`Delivery commit: \\x60${second}\\x60`, "u"));
  assert.match(String(requests[1]!.body?.body), /Production delta: \+322\/-56/u);
  assert.doesNotMatch(String(requests[1]!.body?.body), /Production delta: \+71\/-30/u);
  assert.match(String(requests[1]!.body?.body), /Authored summary stays\./u);
  assert.match(String(requests[1]!.body?.body), /Authored tail stays\./u);
});

test("settlement default uses frozen prose and preserves repository-authored bodies on repeat", async (context) => {
  const { input } = publicationFixture(context, "publication-body"),
    writes: Record<string, unknown>[] = [];
  let exists = false;
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    if (!url.includes("/pulls")) return Response.json({ default_branch: "trunk" });
    if (options.method === "GET") {
      assert.doesNotMatch(url, /base=/u);
      return Response.json(exists ? [{ number: 9, html_url: "https://github.com/acme/repo/pull/9" }] : []);
    }
    writes.push(JSON.parse(String(options.body)));
    exists = true;
    return Response.json({ number: 9, html_url: "https://github.com/acme/repo/pull/9" });
  });
  await publishTaskWorkerBranch(input);
  await publishTaskWorkerBranch(input);
  assert.match(String(writes[0]!.body), /Frozen delivery summary\./u);
  assert.match(String(writes[0]!.body), /Targeted tests passed\./u);
  assert.equal(writes[0]!.base, "trunk");
  assert.equal(writes[0]!.title, "Delivered task");
  assert.doesNotMatch(
    String(writes[0]!.body),
    /External CI pending/u,
    "internal risk and same-mechanism fields are not copied into the default PR body",
  );
  assert.match(String(writes[0]!.body), new RegExp(input.submittedCommitSha, "u"));
  assert.equal(writes.length, 1, "a later settlement leaves existing PR metadata untouched");
});

test("concurrent create conflict resolves the existing branch PR without a second creation", async (context) => {
  const { input } = publicationFixture(context, "publication-race"),
    methods: string[] = [];
  let lists = 0;
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    methods.push(method);
    if (!url.includes("/pulls")) return Response.json({ default_branch: "main" });
    if (method === "GET")
      return Response.json(++lists === 1 ? [] : [{ number: 42, html_url: "https://github.com/acme/repo/pull/42" }]);
    if (method === "POST") return Response.json({ message: "A pull request already exists." }, { status: 422 });
    return Response.json({ number: 42, html_url: "https://github.com/acme/repo/pull/42" });
  });
  const result = await publishTaskWorkerBranch(input);
  assert.equal(result.pullRequest?.url, "https://github.com/acme/repo/pull/42");
  assert.deepEqual(methods, ["GET", "GET", "POST", "GET"]);
});

test("GitLab publication uses the same port and updates the task merge request", async (context) => {
  const { input } = publicationFixture(context, "publication-gitlab"),
    methods: string[] = [];
  let exists = false;
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    assert.match(url, /https:\/\/gitlab.example\/api\/v4\/projects\/acme%2Frepo/u);
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer gitlab-fixture");
    const method = options.method ?? "GET";
    methods.push(method);
    if (!url.includes("/merge_requests")) return Response.json({ default_branch: "main" });
    if (method === "GET") {
      assert.match(url, new RegExp(`source_branch=${fixtureTaskId}`, "u"));
      return Response.json(exists ? [{ iid: 7 }] : []);
    }
    const data = JSON.parse(String(options.body));
    if (method === "POST") assert.equal(data.title, "Delivered task");
    else assert.deepEqual(data, { description: "Explicit GitLab description." });
    exists = true;
    return Response.json({ iid: 7, web_url: "https://gitlab.example/acme/repo/-/merge_requests/7" });
  });
  const gitlab = {
    ...input,
    env: { GITLAB_TOKEN: "gitlab-fixture" },
    pullRequest: {
      ...input.pullRequest,
      body: "Explicit GitLab description.",
      hosting: {
        kind: "gitlab" as const,
        host: "gitlab.example",
        projectPath: "acme/repo",
        apiBaseUrl: "https://gitlab.example/api/v4",
      },
    },
  };
  await publishTaskWorkerBranch(gitlab);
  await publishTaskWorkerBranch(gitlab);
  assert.deepEqual(methods, ["GET", "GET", "POST", "GET", "GET", "PUT"]);
});

test("a push failure never calls hosting and a hosting denial reports the already-pushed branch", async (context) => {
  const { input, fixture } = publicationFixture(context, "publication-fail");
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(null, { status: 403 });
  });
  git(fixture.canonical, "remote", "set-url", "origin", path.join(fixture.root, "missing.git"));
  const failed = await publishTaskWorkerBranch(input);
  assert.ok(failed.push.attempted && !failed.push.ok);
  assert.equal(calls, 0);
  git(fixture.canonical, "remote", "set-url", "origin", fixture.bare);
  await assert.rejects(publishTaskWorkerBranch(input), {
    code: "delivery_publish_failed",
    message: /Branch pushed; PR publication failed: Hosting GET returned HTTP 403.*ha task push/u,
  });
  assert.equal(git(fixture.bare, "rev-parse", `refs/heads/${fixtureTaskId}`).trim(), input.submittedCommitSha);
});

test("an advanced worker HEAD cannot publish stale frozen PR prose", async (context) => {
  const { input, fixture } = publicationFixture(context, "publication-stale");
  git(fixture.worker, "commit", "--allow-empty", "-qm", "fix: later change");
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({});
  });
  await assert.rejects(
    publishTaskWorkerBranch({ ...input, submittedCommitSha: undefined }),
    /ha task submit .* --amend first/u,
  );
  assert.equal(calls, 0);
});

test("terminal settlement persists the PR URL or publication failure without worker GitHub credentials", async (context) => {
  const { fixture, input } = publicationFixture(context, "publication-settlement");
  git(fixture.canonical, "remote", "set-url", "origin", `file://${fixture.bare}`);
  mkdirSync(path.join(fixture.canonical, "harness"), { recursive: true });
  writeFileSync(
    path.join(fixture.canonical, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nsettings:\n  hosting:\n    provider: github\n    host: github.com\n",
  );
  const bodies: string[] = [],
    base = deliveryProjection(input.submittedCommitSha) as TaskProjection,
    snapshot = base.read(fixtureTaskId).snapshot,
    projection = {
      ...base,
      read: () => ({
        ...base.read(fixtureTaskId),
        snapshot: {
          ...snapshot,
          executions: [{ executionId: "execution-owner", submission: input.pullRequest.submission }],
        },
      }),
    },
    settle = workerSettlementContext(fixture, async (type, _payload, _opId, _binding, body) => {
      if (type === "runtime_session_outcome_observed") bodies.push(String(body));
      return {};
    });
  let deny = false;
  let existing: Record<string, unknown> | undefined;
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    if (deny) return new Response(null, { status: 403 });
    if (!url.includes("/pulls")) return Response.json({ default_branch: "main" });
    if (options.method === "GET") return Response.json(existing ? [existing] : []);
    existing = {
      ...existing,
      number: 8,
      html_url: "https://github.com/acme/repo/pull/8",
      ...JSON.parse(String(options.body)),
    };
    return Response.json(existing);
  });
  await publishExit(
    {
      ...settle,
      requiredRuntimeProjection: () => projection as never,
      prepareDaemonGitEnvironment: async () => input.env,
    },
    workerSettlementRuntime(fixture, {}),
    0,
  );
  assert.match(bodies[0]!, /Task pull request published: https:\/\/github.com\/acme\/repo\/pull\/8/u);
  assert.doesNotMatch(bodies[0]!, /gh pr create/u);
  await context.test("repeat settlement preserves a manually edited PR title and body", async () => {
    existing!.title = "CEO-edited PR title";
    existing!.body = "Repository-authored PR body.";
    await publishExit(
      {
        ...settle,
        exiting: new Set(),
        requiredRuntimeProjection: () => projection as never,
        prepareDaemonGitEnvironment: async () => input.env,
      },
      workerSettlementRuntime(fixture, {}),
      0,
    );
    assert.match(bodies[1]!, /Task pull request published:/u);
    assert.equal(existing!.title, "CEO-edited PR title");
    assert.equal(existing!.body, "Repository-authored PR body.");
  });
  deny = true;
  await publishExit(
    {
      ...settle,
      exiting: new Set(),
      requiredRuntimeProjection: () => projection as never,
      prepareDaemonGitEnvironment: async () => input.env,
    },
    workerSettlementRuntime(fixture, {}),
    0,
  );
  assert.match(bodies[2]!, /Branch pushed; PR publication failed: Hosting GET returned HTTP 403/u);
  assert.match(bodies[2]!, new RegExp(`Retry: ha task push ${fixtureTaskId}`, "u"));
});
