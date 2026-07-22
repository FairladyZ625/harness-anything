// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildMainRedIssueBody,
  buildMainRedRecoveryComment,
  isIssueForHeadSha,
  isStaleMainRedRun,
  mainRedIssueTitle,
  mainRedLabel,
  readMainRedRunId,
  selectOpenMainRedIssues
} from "./main-red-notify.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function extractWorkflowScript() {
  const workflow = readFileSync(new URL("../.github/workflows/main-red-notify.yml", import.meta.url), "utf8");
  const lines = workflow.split("\n");
  const marker = lines.findIndex((line) => line.trim() === "script: |");
  assert.notEqual(marker, -1, "workflow must contain a github-script block");
  return lines.slice(marker + 1).filter((line) => line.startsWith("            ")).map((line) => line.slice(12)).join("\n");
}

function workflowHarness({ conclusion, runId, headSha, openIssues = [], jobs = [] }) {
  const calls = { comments: [], creates: [], labels: [], updates: [] };
  const listForRepo = () => {};
  const listJobsForWorkflowRun = () => {};
  const github = {
    paginate: async (endpoint) => endpoint === listForRepo ? openIssues : jobs,
    rest: {
      actions: { listJobsForWorkflowRun },
      issues: {
        listForRepo,
        getLabel: async () => ({ data: { name: "main-red" } }),
        createLabel: async (input) => { calls.labels.push(input); },
        create: async (input) => {
          calls.creates.push(input);
          return { data: { html_url: "https://github.com/example/repo/issues/1" } };
        },
        createComment: async (input) => { calls.comments.push(input); },
        update: async (input) => { calls.updates.push(input); }
      }
    }
  };
  const context = {
    repo: { owner: "example", repo: "repo" },
    payload: {
      workflow_run: {
        conclusion,
        head_sha: headSha,
        html_url: `https://github.com/example/repo/actions/runs/${runId}`,
        id: runId
      }
    }
  };
  const core = { info: () => {} };
  return {
    calls,
    run: async () => new AsyncFunction("github", "context", "core", extractWorkflowScript())(github, context, core)
  };
}

test("failure issue content carries the run, failed jobs, SHA, and advisory boundary", () => {
  const body = buildMainRedIssueBody({
    runId: 42,
    runUrl: "https://github.com/example/repo/actions/runs/42",
    headSha: "abc123",
    failedJobs: ["full-check (24)", "full-check (26)", "full-check (24)"]
  });

  assert.equal(mainRedLabel, "main-red");
  assert.equal(mainRedIssueTitle, "[CI] rewrite-ci is red on main");
  assert.match(body, /main-red-sha:abc123/u);
  assert.match(body, /main-red-run:42/u);
  assert.match(body, /actions\/runs\/42/u);
  assert.equal(body.match(/full-check \(24\)/gu)?.length, 1);
  assert.match(body, /full-check \(26\)/u);
  assert.match(body, /advisory only/u);
  assert.equal(isIssueForHeadSha({ body }, "abc123"), true);
  assert.equal(isIssueForHeadSha({ body }, "def456"), false);
  assert.equal(readMainRedRunId({ body }), 42);
  assert.equal(isStaleMainRedRun({ body }, 41), true);
  assert.equal(isStaleMainRedRun({ body }, 43), false);
});

test("legacy notification issues without a run marker remain eligible for recovery", () => {
  const issue = { body: "<!-- main-red-notification -->" };
  assert.equal(readMainRedRunId(issue), null);
  assert.equal(isStaleMainRedRun(issue, 43), false);
});

test("open notification selection excludes pull requests, closed issues, and other labels", () => {
  const issues = selectOpenMainRedIssues([
    { number: 1, state: "open", labels: [{ name: "main-red" }] },
    { number: 2, state: "closed", labels: [{ name: "main-red" }] },
    { number: 3, state: "open", labels: ["main-red"], pull_request: { url: "https://example.test" } },
    { number: 4, state: "open", labels: [{ name: "other" }] }
  ]);

  assert.deepEqual(issues.map((issue) => issue.number), [1]);
});

test("recovery comment identifies the successful run and head SHA", () => {
  assert.equal(
    buildMainRedRecoveryComment({ runUrl: "https://github.com/example/repo/actions/runs/43", headSha: "def456" }),
    "rewrite-ci is green again on main for `def456`: https://github.com/example/repo/actions/runs/43. Closing this advisory issue."
  );
});

test("workflow stays notify-only and uses the declared minimal permissions", () => {
  const workflow = readFileSync(new URL("../.github/workflows/main-red-notify.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /workflows: \["rewrite-ci"\]/u);
  assert.match(workflow, /branches: \[main\]/u);
  assert.match(workflow, /types: \[completed\]/u);
  assert.match(workflow, /permissions:\n  actions: read\n  issues: write/u);
  assert.doesNotMatch(workflow, /pull_request:|continue-on-error|statuses\.create|checks\.create|merge-queue|\.mergify/u);
  assert.doesNotMatch(workflow, /actions\/checkout/u);
  assert.doesNotThrow(() => new AsyncFunction("github", "context", "core", extractWorkflowScript()));
});

test("workflow failure path creates the locally tested issue content", async () => {
  const harness = workflowHarness({
    conclusion: "failure",
    runId: 42,
    headSha: "abc123",
    jobs: [
      { name: "full-check (24)", conclusion: "failure" },
      { name: "full-check (26)", conclusion: "success" }
    ]
  });
  await harness.run();

  assert.equal(harness.calls.creates.length, 1);
  assert.equal(harness.calls.creates[0].title, mainRedIssueTitle);
  assert.deepEqual(harness.calls.creates[0].labels, [mainRedLabel]);
  assert.equal(harness.calls.creates[0].body, buildMainRedIssueBody({
    runId: 42,
    runUrl: "https://github.com/example/repo/actions/runs/42",
    headSha: "abc123",
    failedJobs: ["full-check (24)"]
  }));
});

test("workflow does not duplicate the same run and ignores stale completions", async () => {
  const currentBody = buildMainRedIssueBody({
    runId: 42,
    runUrl: "https://github.com/example/repo/actions/runs/42",
    headSha: "abc123",
    failedJobs: ["full-check (24)"]
  });
  const duplicate = workflowHarness({
    conclusion: "failure",
    runId: 42,
    headSha: "abc123",
    openIssues: [{ number: 1, body: currentBody }],
    jobs: [{ name: "full-check (24)", conclusion: "failure" }]
  });
  await duplicate.run();
  assert.deepEqual(duplicate.calls.creates, []);
  assert.deepEqual(duplicate.calls.updates, []);

  const staleSuccess = workflowHarness({
    conclusion: "success",
    runId: 41,
    headSha: "older",
    openIssues: [{ number: 1, body: currentBody }]
  });
  await staleSuccess.run();
  assert.deepEqual(staleSuccess.calls.comments, []);
  assert.deepEqual(staleSuccess.calls.updates, []);
});

test("workflow closes an open advisory issue after a newer green run", async () => {
  const failureBody = buildMainRedIssueBody({
    runId: 42,
    runUrl: "https://github.com/example/repo/actions/runs/42",
    headSha: "abc123",
    failedJobs: ["full-check (24)"]
  });
  const harness = workflowHarness({
    conclusion: "success",
    runId: 43,
    headSha: "def456",
    openIssues: [{ number: 1, body: failureBody }]
  });
  await harness.run();

  assert.equal(harness.calls.comments[0].body, buildMainRedRecoveryComment({
    runUrl: "https://github.com/example/repo/actions/runs/43",
    headSha: "def456"
  }));
  assert.deepEqual(harness.calls.updates[0], {
    owner: "example",
    repo: "repo",
    issue_number: 1,
    state: "closed",
    state_reason: "completed"
  });
});
