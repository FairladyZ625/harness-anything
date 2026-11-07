// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SubmissionV1 } from "@harness-anything/kernel";
import { refreshSubmittedPullRequest } from "../src/repo-cell-submit.ts";

const taskId = "task-submit-pr-refresh",
  first = "1".repeat(40),
  second = "2".repeat(40),
  factsBody = (commitSha: string): string =>
    [
      "# Pull request",
      "",
      "Authored summary stays.",
      "",
      "<!-- harness:submission-facts:start -->",
      "## Delivery Facts",
      `- Delivery commit: \`${commitSha}\``,
      "<!-- harness:submission-facts:end -->",
      "",
      "Authored tail stays.",
    ].join("\n"),
  submission = (commitSha: string): SubmissionV1 => ({
    commitSha,
    completionClaim: "Frozen delivery summary.",
    verificationNotes: ["Targeted tests passed."],
    residualRisks: [],
    knownGaps: [],
    deliverables: [],
    outputs: [],
    changedFiles: ["change.txt"],
    productionDelta: { baseSha: "b".repeat(40), added: 1, deleted: 0, changed: [], unclassified: [] },
    completionContract: {} as never,
  });

function fixture(context: test.TestContext, credential = true) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-submit-pr-refresh-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/repo.git"]);
  return {
    root,
    cell: {
      rootDir: root,
      input: {
        repoId: "canonical",
        ...(credential ? { prepareDaemonGitEnvironment: async () => ({ GH_TOKEN: "daemon-only-fixture" }) } : {}),
      },
      projection: {
        readRuntimeDispatch: () => ({ payload: { instanceId: "instance-1" } }),
        read: () => ({ snapshot: { task: { title: "Delivered task" } } }),
      },
    },
    binding: { executionPrincipal: { runtimeSessionId: "runtime-1" } },
  };
}

test("the submit refresh port patches an existing PR body from the new frozen cut", async (context) => {
  const { cell, binding } = fixture(context),
    requests: { method: string; body: Record<string, unknown> | null }[] = [];
  let existing: Record<string, unknown> | undefined = {
    number: 42,
    html_url: "https://github.com/acme/repo/pull/42",
    body: factsBody(first),
  };
  context.mock.method(globalThis, "fetch", async (_url: string | URL, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    if (method === "GET" && !String(_url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if (method === "GET") return Response.json(existing ? [existing] : []);
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    requests.push({ method, body });
    if (method === "PATCH") existing = { ...existing, ...body };
    return Response.json(existing);
  });
  assert.equal(
    await refreshSubmittedPullRequest(cell as never, taskId, submission(second), binding as never),
    null,
    "a successful refresh adds no warning",
  );
  assert.equal(requests.length, 1, "submit patches the open PR and never creates one");
  assert.equal(requests[0]!.method, "PATCH");
  assert.match(String(requests[0]!.body?.body), new RegExp(`Delivery commit: \\x60${second}\\x60`, "u"));
  assert.doesNotMatch(String(requests[0]!.body?.body), new RegExp(first, "u"));
  assert.match(String(requests[0]!.body?.body), /Authored summary stays\./u);
});

test("the submit refresh port leaves a missing PR and a missing credential to the push command", async (context) => {
  const noPr = fixture(context),
    methods: string[] = [];
  context.mock.method(globalThis, "fetch", async (_url: string | URL, options: RequestInit = {}) => {
    methods.push(options.method ?? "GET");
    if ((options.method ?? "GET") === "GET" && !String(_url).includes("/pulls"))
      return Response.json({ default_branch: "main" });
    return Response.json([]);
  });
  assert.equal(
    await refreshSubmittedPullRequest(noPr.cell as never, taskId, submission(second), noPr.binding as never),
    null,
  );
  assert.deepEqual(
    [...new Set(methods)],
    ["GET"],
    "with no open PR the refresh performs reads only and never creates or updates a PR",
  );

  const noCredential = fixture(context, false);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ default_branch: "main" });
  });
  assert.equal(
    await refreshSubmittedPullRequest(
      noCredential.cell as never,
      taskId,
      submission(second),
      noCredential.binding as never,
    ),
    null,
  );
  assert.equal(calls, 0, "without a daemon-held credential the submit port does not call hosting");
});

test("a hosting failure returns a retry warning instead of escaping the submit path", async (context) => {
  const { cell, binding } = fixture(context);
  context.mock.method(globalThis, "fetch", async () => {
    throw new Error("network unavailable");
  });
  const warning = await refreshSubmittedPullRequest(cell as never, taskId, submission(second), binding as never);
  assert.match(String(warning), /PR body refresh failed: network unavailable/u);
  assert.match(String(warning), new RegExp(`Retry: ha task push ${taskId}`, "u"));
});
