// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkPrBody } from "../../check-pr-body.mjs";
import { checkPrGovernance } from "../../check-pr-governance.mjs";
import { validateDependencyDeclaration } from "../dependency-policy.mjs";
import { renderTaskPrBody } from "../render-task-pr-body.mjs";

const taskId = "task-private-example",
  firstSha = "1".repeat(40),
  commitSha = "2".repeat(40),
  baseSha = "3".repeat(40),
  template = readFileSync(new URL("../../../.github/pull_request_template.md", import.meta.url), "utf8"),
  lightweightCloseout = readFileSync(
    new URL(
      "../../../packages/preset/assets/software-coding/presets/standard-task/templates/task.closeout.lightweight/en-US.md",
      import.meta.url,
    ),
    "utf8",
  ),
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
  },
  dependencySubmission = {
    ...codeSubmission,
    deliverables: ["packages/authorization-gui/package.json"],
    changedFiles: ["packages/authorization-gui/package.json"],
    outputs: [],
  },
  dependencyCloseout = closeout.replace(
    "## Same Mechanism Elsewhere",
    `## Dependency Change

- Added the \`./testing\` exports subpath.
- No dependency range changed; the lockfile stays in sync.

## Same Mechanism Elsewhere`,
  );

function receipt(submission, metadata = {}, id = taskId) {
  return {
    ok: true,
    evidence: JSON.stringify({
      task: { taskId: id, iteration: 1, metadata },
      executions: [
        { taskId: id, iteration: 0, submittedAt: "2026-10-20T00:00:00.000Z", submission: { commitSha: firstSha } },
        {
          taskId: id,
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

test("PR renderer keeps the none sentinel when the cut does not touch the dependency surface", () => {
  assert.match(render(), /^Dependency-Change: none$/mu);
});

test("PR renderer describes a package.json change instead of the rejected none sentinel", () => {
  const body = render(dependencySubmission, { closeout: dependencyCloseout });
  assert.match(
    body,
    /^Dependency-Change: Added the `\.\/testing` exports subpath\. No dependency range changed; the lockfile stays in sync\.$/mu,
  );
  assert.doesNotMatch(body, /^Dependency-Change: none$/mu);
  assert.doesNotMatch(body, /## Dependency Change/u, "the closeout-only section is not injected as a new PR section");
  assert.deepEqual(
    validateDependencyDeclaration(dependencySubmission.changedFiles, body),
    [],
    "the rendered body passes G31's own declaration check",
  );
  assertPassesPrBodyCheck(body, dependencySubmission);
});

test("PR renderer declares a touched protected surface with the task as authority", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../gate-manifest.json", import.meta.url), "utf8")),
    protectedId = "task_0123456789abcdef0123456789",
    submission = { ...codeSubmission, changedFiles: [...codeSubmission.changedFiles, "tools/run-node-tests.mjs"] },
    body = renderTaskPrBody({
      taskId: protectedId,
      receipt: receipt(submission, {}, protectedId),
      template,
      closeout,
      manifest,
    });
  assert.match(body, /^- Protected surface touched: yes$/mu);
  assert.match(body, /^- Protected surface scope: `"tools\/run-node-tests\.mjs"`$/mu);
  assert.match(body, new RegExp(`^- Authority: ${protectedId}$`, "mu"));
  const governance = checkPrGovernance({ body, changedFiles: submission.changedFiles, manifest });
  assert.equal(governance.ok, true, governance.issues.join("\n"));
});

test("PR renderer keeps the governance defaults when no protected surface is touched", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../gate-manifest.json", import.meta.url), "utf8")),
    body = render(codeSubmission, { manifest });
  assert.match(body, /^- Protected surface touched: no$/mu);
  assert.match(body, /^- Authority: not applicable$/mu);
});

test("PR renderer treats a lockfile-only cut as a dependency change", () => {
  const body = render(
    { ...dependencySubmission, changedFiles: ["package-lock.json"] },
    { closeout: dependencyCloseout },
  );
  assert.match(body, /^Dependency-Change: Added the `\.\/testing` exports subpath\./mu);
  assert.deepEqual(validateDependencyDeclaration(["package-lock.json"], body), []);
});

test("PR renderer names Dependency Change when a dependency cut has no closeout section", () => {
  assert.throws(
    () => render(dependencySubmission),
    /closeout\.md is missing required section\(s\): Dependency Change/u,
  );
  assert.throws(
    () => render({ ...dependencySubmission, changedFiles: ["package-lock.json"] }),
    /closeout\.md is missing required section\(s\): Dependency Change/u,
  );
});

test("PR renderer rejects a Dependency Change section that G31 rejects", () => {
  const sentinel = closeout.replace(
    "## Same Mechanism Elsewhere",
    "## Dependency Change\n\nnone\n\n## Same Mechanism Elsewhere",
  );
  assert.throws(
    () => render(dependencySubmission, { closeout: sentinel }),
    /must describe the deterministic dependency change/u,
  );
});

test("PR renderer maps a lightweight closeout onto the four template sections", () => {
  const body = renderTaskPrBody({
    taskId,
    receipt: receipt(codeSubmission, { profileId: "lightweight" }),
    template,
    closeout: lightweightCloseout,
  });
  assert.match(body, /## What Changed\n\nSummarize the completed behavior change\./u);
  assert.match(body, /## Verification\n\nOne test command and its receipt:/u);
  assert.match(body, /## Residual Risk\n\nAccepted residual risks are recorded in the Verification section\./u);
  assertPassesPrBodyCheck(body);
});

test("a lightweight closeout without Summary cannot invent What Changed", () => {
  assert.throws(
    () =>
      renderTaskPrBody({
        taskId,
        receipt: receipt(codeSubmission, { profileId: "lightweight" }),
        template,
        closeout: "# Closeout\n\n## Verification\n\nRan the test.\n",
      }),
    /closeout\.md is missing required section\(s\): Summary, What Changed/u,
  );
});

test("PR renderer names every missing closeout section and invents no placeholder prose", () => {
  const partial = "# Closeout\n\n## Summary\n\nOnly a summary.\n";
  assert.throws(
    () => render(codeSubmission, { closeout: partial }),
    /closeout\.md is missing required section\(s\): Verification, Residual Risk/u,
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

test("a baseline closeout frozen before What Changed reuses the authored Summary", () => {
  const historical = closeout.replace(/## What Changed[\s\S]*?(?=## Verification)/u, "");
  assert.doesNotMatch(historical, /## What Changed/u, "the fixture reproduces the pre-scaffold closeout");
  const body = render(codeSubmission, { closeout: historical });
  assert.match(body, new RegExp(`## What Changed\\n\\n${summary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.doesNotMatch(body, /changed paths; production delta/u, "the renderer does not invent machine prose");
  assertPassesPrBodyCheck(body);
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

test("authored closeout prose cannot mint a second submission-facts marker", () => {
  const authored = closeout.replace(
    verification,
    `${verification}\n\n<!-- harness:submission-facts:start -->\n<!-- harness:submission-facts:end -->`,
  );
  assert.throws(
    () => render(codeSubmission, { closeout: authored }),
    /## Verification contains a submission-facts marker/u,
    "the published body keeps one machine-owned marker pair; the author rewrites the literal text",
  );
});
