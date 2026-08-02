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
  mainRedWorkflowIdentity,
  mainRedWorkflowMarker,
  readMainRedRunId,
  readMainRedWorkflowIdentity,
  selectOpenMainRedIssues,
  selectWorkflowMainRedIssues
} from "./main-red-notify.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const REWRITE_CI = { id: 111, name: "rewrite-ci" };
const NIGHTLY = { id: 222, name: "nightly-integration" };

function extractWorkflowScript() {
  const workflow = readFileSync(new URL("../.github/workflows/main-red-notify.yml", import.meta.url), "utf8");
  const lines = workflow.split("\n");
  const marker = lines.findIndex((line) => line.trim() === "script: |");
  assert.notEqual(marker, -1, "workflow must contain a github-script block");
  return lines.slice(marker + 1).filter((line) => line.startsWith("            ")).map((line) => line.slice(12)).join("\n");
}

// Every behavioural case below drives the extracted inline script, not the module. Asserting a
// property only against the module leaves the deployed copy free to drift: a mutation review
// found that removing the workflow's slug sanitiser, repointing its legacy fallback, and
// loosening its staleness comparison all left an earlier version of this suite green.
function workflowHarness({
  conclusion,
  runId,
  headSha,
  workflow = REWRITE_CI,
  openIssues = [],
  jobs = []
}) {
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
        id: runId,
        name: workflow.name,
        workflow_id: workflow.id
      }
    }
  };
  const core = { info: () => {} };
  return {
    calls,
    run: async () => new AsyncFunction("github", "context", "core", extractWorkflowScript())(github, context, core)
  };
}

function advisoryBody({ workflow, runId, headSha, failedJobs = ["some-job"] }) {
  return buildMainRedIssueBody({
    workflowId: workflow.id,
    workflowName: workflow.name,
    runId,
    runUrl: `https://github.com/example/repo/actions/runs/${runId}`,
    headSha,
    failedJobs
  });
}

test("failure issue content carries the run, failed jobs, SHA, and advisory boundary", () => {
  const body = advisoryBody({
    workflow: REWRITE_CI,
    runId: 42,
    headSha: "abc123",
    failedJobs: ["full-check (24)", "full-check (26)", "full-check (24)"]
  });

  assert.equal(mainRedLabel, "main-red");
  assert.equal(mainRedIssueTitle("rewrite-ci"), "[CI] rewrite-ci is red on main");
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
  // A re-run keeps the same run id, so the recorded run is not newer than itself.
  assert.equal(isStaleMainRedRun({ body }, 42), false);
});

test("issue identity is the workflow id, and the display name is only displayed", () => {
  const body = advisoryBody({ workflow: NIGHTLY, runId: 44, headSha: "nightly123" });

  assert.equal(readMainRedWorkflowIdentity({ body }), "222");
  assert.match(body, /## nightly-integration is red on main/u);
  assert.match(body, /- Workflow: nightly-integration/u);
  assert.equal(mainRedIssueTitle("nightly-integration"), "[CI] nightly-integration is red on main");
});

test("an issue that declares no owner is owned by nobody", () => {
  // Advisory issues opened before per-workflow identity carried a rewrite-ci title regardless
  // of which workflow had failed, so attributing them to rewrite-ci would reproduce exactly the
  // wrong-workflow closure this change removes.
  const legacy = { body: "<!-- main-red-notification -->\n<!-- main-red-run:50 -->", state: "open", labels: [{ name: "main-red" }] };

  assert.equal(readMainRedWorkflowIdentity(legacy), null);
  assert.deepEqual(selectWorkflowMainRedIssues([legacy], REWRITE_CI.id), []);
  assert.deepEqual(selectWorkflowMainRedIssues([legacy], NIGHTLY.id), []);
});

test("identity survives a rename and does not collide across similar names", () => {
  assert.equal(mainRedWorkflowIdentity(111), mainRedWorkflowIdentity(111));
  assert.notEqual(mainRedWorkflowIdentity(111), mainRedWorkflowIdentity(222));
  // Two display names that would slugify to the same string still have distinct identities.
  const renamed = advisoryBody({ workflow: { id: 111, name: "rewrite ci" }, runId: 42, headSha: "abc123" });
  const original = advisoryBody({ workflow: REWRITE_CI, runId: 42, headSha: "abc123" });
  assert.equal(readMainRedWorkflowIdentity({ body: renamed }), readMainRedWorkflowIdentity({ body: original }));
});

test("a hostile identity cannot terminate the marker it is embedded in", () => {
  const hostile = mainRedWorkflowMarker("222 --> <!-- main-red-workflow:111");
  assert.equal(hostile.match(/-->/gu)?.length, 1);
  assert.notEqual(readMainRedWorkflowIdentity({ body: hostile }), "111");
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

test("workflow selection keeps only the advisory issue that workflow owns", () => {
  const issues = [
    { number: 1, state: "open", labels: [{ name: "main-red" }], body: mainRedWorkflowMarker(REWRITE_CI.id) },
    { number: 2, state: "open", labels: [{ name: "main-red" }], body: mainRedWorkflowMarker(NIGHTLY.id) },
    { number: 3, state: "open", labels: [{ name: "main-red" }], body: "<!-- main-red-notification -->" }
  ];

  assert.deepEqual(selectWorkflowMainRedIssues(issues, NIGHTLY.id).map((issue) => issue.number), [2]);
  assert.deepEqual(selectWorkflowMainRedIssues(issues, REWRITE_CI.id).map((issue) => issue.number), [1]);
});

test("recovery comment identifies the workflow, successful run, and head SHA", () => {
  assert.equal(
    buildMainRedRecoveryComment({
      workflowName: "rewrite-ci",
      runUrl: "https://github.com/example/repo/actions/runs/43",
      headSha: "def456"
    }),
    "rewrite-ci is green again on main for `def456`: https://github.com/example/repo/actions/runs/43. Closing this advisory issue."
  );
  assert.match(
    buildMainRedRecoveryComment({
      workflowName: "nightly-integration",
      runUrl: "https://github.com/example/repo/actions/runs/45",
      headSha: "def456"
    }),
    /^nightly-integration is green again/u
  );
});

test("workflow stays notify-only and uses the declared minimal permissions", () => {
  const workflow = readFileSync(new URL("../.github/workflows/main-red-notify.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /workflows: \["rewrite-ci", "nightly-integration"\]/u);
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
  assert.equal(harness.calls.creates[0].title, mainRedIssueTitle("rewrite-ci"));
  assert.deepEqual(harness.calls.creates[0].labels, [mainRedLabel]);
  assert.equal(harness.calls.creates[0].body, advisoryBody({
    workflow: REWRITE_CI,
    runId: 42,
    headSha: "abc123",
    failedJobs: ["full-check (24)"]
  }));
});

test("nightly-integration failure opens an advisory issue under its own name and identity", async () => {
  const harness = workflowHarness({
    conclusion: "failure",
    runId: 44,
    headSha: "nightly123",
    workflow: NIGHTLY,
    jobs: [{ name: "production-authority-perf-matrix", conclusion: "failure" }]
  });
  await harness.run();

  assert.equal(harness.calls.creates.length, 1);
  assert.equal(harness.calls.creates[0].title, mainRedIssueTitle("nightly-integration"));
  assert.equal(harness.calls.creates[0].body, advisoryBody({
    workflow: NIGHTLY,
    runId: 44,
    headSha: "nightly123",
    failedJobs: ["production-authority-perf-matrix"]
  }));
});

test("the workflow embeds its identity as the workflow id, not the display name", async () => {
  const harness = workflowHarness({
    conclusion: "failure",
    runId: 46,
    headSha: "abc123",
    workflow: { id: 333, name: "rewrite ci" },
    jobs: [{ name: "some-job", conclusion: "failure" }]
  });
  await harness.run();

  assert.equal(readMainRedWorkflowIdentity({ body: harness.calls.creates[0].body }), "333");
});

test("the workflow's own sanitiser keeps a hostile identity inside one marker", async () => {
  const harness = workflowHarness({
    conclusion: "failure",
    runId: 46,
    headSha: "abc123",
    workflow: { id: "222 --> <!-- main-red-workflow:111", name: "hostile" },
    jobs: [{ name: "some-job", conclusion: "failure" }]
  });
  await harness.run();

  const identity = readMainRedWorkflowIdentity({ body: harness.calls.creates[0].body });
  assert.notEqual(identity, "111", "a hostile identity impersonated another workflow");
  assert.equal(identity, mainRedWorkflowIdentity("222 --> <!-- main-red-workflow:111"));
});

test("a green run does not retire another workflow's advisory issue", async () => {
  const harness = workflowHarness({
    conclusion: "success",
    runId: 45,
    headSha: "def456",
    workflow: REWRITE_CI,
    openIssues: [{ number: 42, body: advisoryBody({ workflow: NIGHTLY, runId: 44, headSha: "nightly123" }) }]
  });
  await harness.run();

  assert.deepEqual(harness.calls.updates, [], "a green rewrite-ci run closed nightly-integration's advisory issue");
  assert.deepEqual(harness.calls.comments, []);
});

test("neither workflow retires an advisory issue that declares no owner", async () => {
  const legacyIssue = { number: 7, body: "<!-- main-red-notification -->\n<!-- main-red-run:50 -->" };

  for (const workflow of [REWRITE_CI, NIGHTLY]) {
    const harness = workflowHarness({
      conclusion: "success",
      runId: 60,
      headSha: "def456",
      workflow,
      openIssues: [legacyIssue]
    });
    await harness.run();
    assert.deepEqual(
      harness.calls.updates,
      [],
      `${workflow.name} retired a pre-identity advisory issue whose owner is unknown`
    );
  }
});

test("a failing run opens its own advisory issue instead of overwriting another workflow's", async () => {
  const harness = workflowHarness({
    conclusion: "failure",
    runId: 44,
    headSha: "nightly123",
    workflow: NIGHTLY,
    openIssues: [{ number: 9, body: advisoryBody({ workflow: REWRITE_CI, runId: 40, headSha: "abc123" }) }],
    jobs: [{ name: "production-authority-perf-matrix", conclusion: "failure" }]
  });
  await harness.run();

  assert.equal(harness.calls.creates.length, 1);
  assert.deepEqual(harness.calls.updates, [], "nightly-integration overwrote rewrite-ci's advisory issue");
});

test("workflow does not duplicate the same run and ignores stale completions", async () => {
  const currentBody = advisoryBody({ workflow: REWRITE_CI, runId: 42, headSha: "abc123", failedJobs: ["full-check (24)"] });
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

test("a re-run of the same failed run closes the advisory issue it opened", async () => {
  // GitHub keeps the run id across a re-run, so an equal id must not be treated as stale.
  const failureBody = advisoryBody({ workflow: REWRITE_CI, runId: 42, headSha: "abc123", failedJobs: ["full-check (24)"] });
  const harness = workflowHarness({
    conclusion: "success",
    runId: 42,
    headSha: "abc123",
    openIssues: [{ number: 1, body: failureBody }]
  });
  await harness.run();

  assert.deepEqual(
    harness.calls.updates.map((update) => update.state),
    ["closed"],
    "a re-run's equal run id was treated as stale, so the advisory issue was never retired"
  );
});

test("workflow closes an open advisory issue after a newer green run", async () => {
  const failureBody = advisoryBody({ workflow: REWRITE_CI, runId: 42, headSha: "abc123", failedJobs: ["full-check (24)"] });
  const harness = workflowHarness({
    conclusion: "success",
    runId: 43,
    headSha: "def456",
    openIssues: [{ number: 1, body: failureBody }]
  });
  await harness.run();

  assert.equal(harness.calls.comments[0].body, buildMainRedRecoveryComment({
    workflowName: "rewrite-ci",
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

test("each watched workflow recovers only its own advisory issue", async () => {
  const issues = [
    { number: 1, body: advisoryBody({ workflow: REWRITE_CI, runId: 40, headSha: "abc123" }) },
    { number: 2, body: advisoryBody({ workflow: NIGHTLY, runId: 41, headSha: "nightly123" }) }
  ];

  const rewriteGreen = workflowHarness({ conclusion: "success", runId: 50, headSha: "def456", workflow: REWRITE_CI, openIssues: issues });
  await rewriteGreen.run();
  assert.deepEqual(rewriteGreen.calls.updates.map((update) => update.issue_number), [1]);

  const nightlyGreen = workflowHarness({ conclusion: "success", runId: 51, headSha: "def456", workflow: NIGHTLY, openIssues: issues });
  await nightlyGreen.run();
  assert.deepEqual(nightlyGreen.calls.updates.map((update) => update.issue_number), [2]);
});
