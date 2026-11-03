// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkPrBody } from "../../check-pr-body.mjs";
import { renderTaskPrBody } from "../render-task-pr-body.mjs";

const taskId = "task-private-example",
  firstSha = "1".repeat(40),
  commitSha = "2".repeat(40),
  baseSha = "3".repeat(40),
  template = readFileSync(new URL("../../../.github/pull_request_template.md", import.meta.url), "utf8"),
  summary = "The renderer fills this summary from the task closeout.",
  whatChanged = "- Read the closeout sections.\n- Fill the four PR sections.",
  verification = "- Isolated renderer test passed.",
  residualRisk = "- None beyond the template.",
  closeout = `# Closeout

## Summary

${summary}

## What Changed

${whatChanged}

## Verification

${verification}

## Residual Risk

${residualRisk}

## Same Mechanism Elsewhere

Not emitted into the PR body.
`,
  codeSubmission = {
    commitSha,
    deliverables: ["packages/kernel/a.ts"],
    changedFiles: ["packages/kernel/a.ts", "docs/change.md", "packages/old.ts"],
    outputs: ["Deleted-Production-Paths: packages/old.ts"],
    productionDelta: { baseSha, added: 5, deleted: 2, changed: [], unclassified: [] },
  };

function receipt(submission) {
  return {
    ok: true,
    evidence: JSON.stringify({
      task: { taskId, iteration: 1 },
      executions: [
        { taskId, iteration: 0, submittedAt: "2026-10-20T00:00:00.000Z", submission: { commitSha: firstSha } },
        {
          taskId,
          iteration: 1,
          submittedAt: "2026-10-21T00:00:00.000Z",
          submission,
        },
      ],
    }),
  };
}

function render(submission = codeSubmission, options = {}) {
  return renderTaskPrBody({
    taskId,
    receipt: receipt(submission),
    template,
    closeout,
    ...options,
  });
}

function assertPassesPrBodyCheck(body, submission = codeSubmission) {
  const result = checkPrBody(body, {
    prTemplate: template,
    eventMigration: { files: submission.changedFiles ?? [] },
  });
  assert.equal(result.ok, true, result.issues.join("\n"));
}

test("PR renderer fills the four authored sections from closeout and passes check-pr-body", () => {
  const body = render();
  assert.match(body, new RegExp(`## Summary\\n\\n${summary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.match(body, /## What Changed\n\n- Read the closeout sections\.\n- Fill the four PR sections\./u);
  assert.match(body, /## Verification\n\n- Isolated renderer test passed\./u);
  assert.match(body, /## Residual Risk\n\n- None beyond the template\./u);
  assert.doesNotMatch(body, /Not emitted into the PR body\./u, "Same Mechanism Elsewhere stays out of the PR body");
  assert.match(body, new RegExp(`Delivery commit: \\x60${commitSha}\\x60`, "u"));
  assert.match(body, new RegExp(`Merge base: \\x60${baseSha}\\x60`, "u"));
  assert.match(body, /Production delta: \+5\/-2 \(net \+3\)/u);
  assert.match(body, /docs\/change\.md/u);
  assert.equal((body.match(/## Delivery Facts/gu) ?? []).length, 1);
  assert.doesNotMatch(body, new RegExp(taskId, "u"), "the renderer does not add the task id on its own");
  assertPassesPrBodyCheck(body);
});

test("PR renderer names every missing closeout section and invents no placeholder prose", () => {
  const partial = "# Closeout\n\n## Summary\n\nOnly a summary.\n";
  assert.throws(
    () => render(codeSubmission, { closeout: partial }),
    /closeout\.md is missing required section\(s\): What Changed, Verification, Residual Risk/u,
  );
});

test("PR renderer renders the frozen cut when HEAD is not the delivery commit", () => {
  const body = render(codeSubmission, { headSha: firstSha });
  assert.match(body, new RegExp(`Delivery commit: \\x60${commitSha}\\x60`, "u"));
  assert.doesNotMatch(body, /HEAD differs|amend the submission/u);
});

test("re-rendering a body refreshes delivery facts but keeps authored sections", () => {
  const initial = render(),
    edited = initial.replace(summary, "Hand-edited summary."),
    refreshed = render(
      { ...codeSubmission, productionDelta: { ...codeSubmission.productionDelta, added: 8 } },
      { body: edited },
    );
  assert.match(refreshed, /Hand-edited summary\./u);
  assert.doesNotMatch(refreshed, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(refreshed, /Production delta: \+8\/-2 \(net \+6\)/u);
  assert.equal((refreshed.match(/## Delivery Facts/gu) ?? []).length, 1);
  assertPassesPrBodyCheck(refreshed);
});

test("a closeout without What Changed is rejected instead of silently falling back", () => {
  const historical = closeout.replace(/## What Changed[\s\S]*?(?=## Verification)/u, "");
  assert.throws(
    () => render(codeSubmission, { closeout: historical }),
    /closeout\.md is missing required section\(s\): What Changed/u,
  );
});

test("PR renderer recognises the Chinese closeout section names", () => {
  const chinese = `# Closeout

## 概要

中文概要。

## 改动

- 中文改动。

## 验证

- 中文验证。

## 剩余风险

- 中文风险。
`;
  const body = render(codeSubmission, { closeout: chinese });
  for (const value of ["中文概要。", "- 中文改动。", "- 中文验证。", "- 中文风险。"])
    assert.match(body, new RegExp(value, "u"));
  assertPassesPrBodyCheck(body);
});

test("PR renderer rejects authored content that would add a top-level section", () => {
  assert.throws(
    () =>
      render(codeSubmission, {
        closeout: closeout.replace(summary, "Real summary.\n\n```text\n## Injected\n```"),
      }),
    /top-level "## " heading/u,
  );
});

test("PR renderer keeps a task-id branch name authored in the closeout", () => {
  const branchName = "task_0123456789abcdef01234567",
    body = render(codeSubmission, { closeout: closeout.replace(summary, `${summary} See ${branchName}.`) });
  assert.match(body, new RegExp(`## Summary\\n\\n${summary} See ${branchName}\\.`, "u"));
  assertPassesPrBodyCheck(body);
});

test("PR renderer labels artifact-only submissions without inventing commit facts", () => {
  const body = render({ commitSha: null, deliverables: ["tasks/private/artifacts/report.md"], outputs: [] });
  assert.match(body, /artifact-only; no public Git commit/u);
  assert.match(body, /Delivered artifacts: 1 center-accepted artifact/u);
  assert.match(body, /## What Changed\n\n- Read the closeout sections\./u);
  assert.doesNotMatch(
    body,
    /tasks\/private\/artifacts\/report\.md/u,
    "private artifact paths stay out of public PR text",
  );
  assert.doesNotMatch(body, /Merge base|Production delta/u);
});

test("PR renderer keeps unusual file paths on one literal Markdown line", () => {
  const filePath = "src/backtick`and\n- injected.md",
    body = render({
      commitSha,
      deliverables: [],
      changedFiles: [filePath],
      outputs: [],
      productionDelta: { baseSha, added: 0, deleted: 0, changed: [], unclassified: [filePath] },
    });
  assert.match(body, /  - ``"src\/backtick`and\\n- injected\.md"``/u);
  assert.doesNotMatch(body, /src\/backtick`and\n- injected/u);
});

test("PR renderer labels legacy facts and rejects broken markers", () => {
  const legacy = render({
    commitSha,
    deliverables: ["README.md", "packages/kernel/old.ts"],
    outputs: ["Deleted-Production-Paths: packages/kernel/retired.ts"],
  });
  assert.match(legacy, /Legacy submission facts/u);
  assert.match(legacy, /Production delta: unavailable on this legacy cut/u);
  assert.match(legacy, /README\.md/u);
  assert.match(legacy, /packages\/kernel\/retired\.ts/u);
  assert.throws(
    () => renderTaskPrBody({ taskId, receipt: receipt(codeSubmission), template: "# PR\n", closeout }),
    /marker pair/u,
  );
  assert.throws(() => render(codeSubmission, { closeout: "" }), /closeout\.md is missing required section/u);
});
