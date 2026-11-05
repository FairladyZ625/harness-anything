// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkPrBody } from "../../check-pr-body.mjs";
import { checkPrGovernance } from "../../check-pr-governance.mjs";
import { validateDependencyDeclaration } from "../dependency-policy.mjs";
import { renderTaskPrBody } from "../render-task-pr-body.mjs";
import { submissionFromCloseout } from "../../../packages/kernel/src/domain/transition-document-readiness.ts";

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
  ),
  manifest = JSON.parse(readFileSync(new URL("../../gate-manifest.json", import.meta.url), "utf8")),
  protectedId = "task_0123456789abcdef0123456789",
  protectedFiles = ["tools/gate-allowlists/check-fallback-boundaries.json", "tools/gates/cost-budget.json"],
  // A body can reach the renderer from an author or an older template without the governance
  // defaults; the marker pair and the four authored sections are what the renderer requires.
  templateWithoutGovernance = template.replace(/^## Governance Declaration\n[\s\S]*?(?=^## Verification)/mu, "");

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

test("PR renderer preserves exact and suffixed authored risk sections in source order", () => {
  const firstRisk = "A: security issue open.",
    suffixedRisk = "B: critical credentials exposed.",
    authored = closeout.replace(residualRisk, `${firstRisk}\n\n## Residual Risk (security)\n\n${suffixedRisk}`),
    submitted = submissionFromCloseout(authored, codeSubmission),
    body = render(submitted, { closeout: authored });
  assert.ok(submitted.residualRisks.some((risk) => risk.includes(suffixedRisk)));
  assert.ok(body.includes(firstRisk), "the original risk remains verbatim");
  assert.ok(body.includes(suffixedRisk), "the suffixed risk remains verbatim");
  assert.ok(body.indexOf(firstRisk) < body.indexOf(suffixedRisk), "risks retain the authored order");
  assertPassesPrBodyCheck(body);
});

test("PR renderer preserves interleaved repeated risk sections in source order", () => {
  const risks = ["A: issue opened.", "B: issue fixed.", "C: issue reopened."],
    authored = closeout.replace(
      residualRisk,
      `${risks[0]}\n\n## Residual Risk (security)\n\n${risks[1]}\n\n## Residual Risk\n\n${risks[2]}`,
    ),
    submitted = submissionFromCloseout(authored, codeSubmission),
    body = render(submitted, { closeout: authored }),
    riskBody = body.match(/## Residual Risk\n([\s\S]*?)(?=\n## |$)/u)?.[1].trim();
  assert.ok(submitted.residualRisks.includes(risks.join("\n\n")), "the frozen risks retain the authored order");
  assert.equal(riskBody, risks.join("\n\n"), "the PR must end with the reopened issue, matching the frozen risks");
  assertPassesPrBodyCheck(body);
});

test("PR renderer replaces only the generated dependency declaration and preserves the authored Summary", () => {
  const authoredSummary = "Observed problem:\nDependency-Change: unpinned production package",
    authored = dependencyCloseout.replace(summary, authoredSummary),
    body = render(dependencySubmission, { closeout: authored });
  assert.ok(body.includes(authoredSummary), "the author's complete Summary remains verbatim");
  assert.match(
    body,
    /^Dependency-Change: Added the `\.\/testing` exports subpath\. No dependency range changed; the lockfile stays in sync\.$/mu,
  );
  assert.notDeepEqual(validateDependencyDeclaration(dependencySubmission.changedFiles, body), []);
  const refreshed = render(dependencySubmission, { closeout: authored, body });
  assert.ok(refreshed.includes(authoredSummary), "re-rendering also preserves the author's complete Summary");
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
  const submission = { ...codeSubmission, changedFiles: [...codeSubmission.changedFiles, "tools/run-node-tests.mjs"] },
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
  assert.equal((body.match(/^## Governance Declaration$/gmu) ?? []).length, 1, "the template default is replaced");
  const governance = checkPrGovernance({ body, changedFiles: submission.changedFiles, manifest });
  assert.equal(governance.ok, true, governance.issues.join("\n"));
});

test("PR renderer keeps the governance defaults when no protected surface is touched", () => {
  const body = render(codeSubmission, { manifest });
  assert.match(body, /^- Protected surface touched: no$/mu);
  assert.match(body, /^- Authority: not applicable$/mu);
});

function protectedSubmission() {
  return { ...codeSubmission, changedFiles: [...codeSubmission.changedFiles, ...protectedFiles] };
}

test("PR renderer generates the governance declaration when the body has no section", () => {
  const submission = protectedSubmission(),
    body = renderTaskPrBody({
      taskId: protectedId,
      receipt: receipt(submission, {}, protectedId),
      template: templateWithoutGovernance,
      closeout,
      manifest,
    });
  assert.match(body, /^## Governance Declaration$/mu);
  assert.match(body, /^- Protected surface touched: yes$/mu);
  assert.match(body, new RegExp(`^- Authority: ${protectedId}$`, "mu"));
  for (const file of protectedFiles) assert.ok(body.includes(`"${file}"`), `${file} is named in the scope`);
  assert.equal((body.match(/^## Governance Declaration$/gmu) ?? []).length, 1);
  assert.ok(
    body.indexOf("## Governance Declaration") < body.indexOf("## Verification"),
    "the generated declaration keeps the template order",
  );
  const governance = checkPrGovernance({ body, changedFiles: submission.changedFiles, manifest });
  assert.equal(governance.ok, true, governance.issues.join("\n"));
  assertPassesPrBodyCheck(body, submission);
});

test("PR renderer does not add a governance declaration to an unprotected cut", () => {
  const body = renderTaskPrBody({
    taskId: protectedId,
    receipt: receipt(codeSubmission, {}, protectedId),
    template: templateWithoutGovernance,
    closeout,
    manifest,
  });
  assert.doesNotMatch(body, /^## Governance Declaration$/mu);
  assert.equal(checkPrGovernance({ body, changedFiles: codeSubmission.changedFiles, manifest }).skipped, true);
  assertPassesPrBodyCheck(body);
});

test("re-rendering a protected cut keeps exactly one governance declaration", () => {
  const submission = protectedSubmission(),
    first = renderTaskPrBody({
      taskId: protectedId,
      receipt: receipt(submission, {}, protectedId),
      template: templateWithoutGovernance,
      closeout,
      manifest,
    }),
    second = renderTaskPrBody({
      taskId: protectedId,
      receipt: receipt(submission, {}, protectedId),
      template: templateWithoutGovernance,
      closeout,
      manifest,
      body: first,
    });
  assert.equal((second.match(/^## Governance Declaration$/gmu) ?? []).length, 1);
  assert.match(second, new RegExp(`^- Authority: ${protectedId}$`, "mu"));
  assert.equal(checkPrGovernance({ body: second, changedFiles: submission.changedFiles, manifest }).ok, true);
  assertPassesPrBodyCheck(second, submission);
});

test("an authored governance declaration with a citation survives re-rendering", () => {
  const submission = protectedSubmission(),
    authored = templateWithoutGovernance.replace(
      "## Verification",
      "## Governance Declaration\n\n- Authority: ADR-0023 D5/D8\n- Break-glass: no\n\n## Verification",
    ),
    body = renderTaskPrBody({
      taskId: protectedId,
      receipt: receipt(submission, {}, protectedId),
      template: templateWithoutGovernance,
      closeout,
      manifest,
      body: authored,
    });
  assert.match(body, /^- Authority: ADR-0023 D5\/D8$/mu);
  assert.doesNotMatch(body, new RegExp(`^- Authority: ${protectedId}$`, "mu"));
  assert.equal((body.match(/^## Governance Declaration$/gmu) ?? []).length, 1);
  assert.equal(checkPrGovernance({ body, changedFiles: submission.changedFiles, manifest }).ok, true);
});

test("PR renderer treats a lockfile-only cut as a dependency change", () => {
  const body = render(
    { ...dependencySubmission, changedFiles: ["package-lock.json"] },
    { closeout: dependencyCloseout },
  );
  assert.match(body, /^Dependency-Change: Added the `\.\/testing` exports subpath\./mu);
  assert.deepEqual(validateDependencyDeclaration(["package-lock.json"], body), []);
});

test("PR renderer writes the dependency declaration when the body deleted the template line", () => {
  const withoutLine = template.replace(/^Dependency-Change: none\n/mu, ""),
    body = renderTaskPrBody({
      taskId,
      receipt: receipt(dependencySubmission),
      template: withoutLine,
      closeout: dependencyCloseout,
    });
  assert.match(body, /^Dependency-Change: Added the `\.\/testing` exports subpath\./mu);
  assert.equal((body.match(/^Dependency-Change:/gmu) ?? []).length, 1);
  assert.deepEqual(validateDependencyDeclaration(dependencySubmission.changedFiles, body), []);
});

test("PR renderer leaves dependency lint to its independent publication check", () => {
  const body = render(dependencySubmission);
  assert.match(body, /^Dependency-Change: none$/mu);
  assert.notDeepEqual(validateDependencyDeclaration(dependencySubmission.changedFiles, body), []);
  const duplicated = render(dependencySubmission, {
    closeout: dependencyCloseout.replace(summary, `${summary}\nDependency-Change: extra`),
  });
  assert.equal((duplicated.match(/^Dependency-Change:/gmu) ?? []).length, 2);
  assert.notDeepEqual(validateDependencyDeclaration(dependencySubmission.changedFiles, duplicated), []);
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

test("a lightweight closeout without Summary fills the template from authored prose", () => {
  const body = renderTaskPrBody({
    taskId,
    receipt: receipt(codeSubmission, { profileId: "lightweight" }),
    template,
    closeout: "# Closeout\n\n## Verification\n\nRan the test.\n",
  });
  assert.match(body, /## Summary\n\n# Closeout\n\n### Verification\n\nRan the test\./u);
  assert.match(body, /## What Changed\n\n# Closeout\n\n### Verification\n\nRan the test\./u);
  assertPassesPrBodyCheck(body);
});

test("PR renderer fills every missing template section from authored prose", () => {
  const partial = "# Closeout\n\n## Summary\n\nOnly a summary.\n",
    body = render(codeSubmission, { closeout: partial });
  assert.match(body, /## Verification\n\n# Closeout\n\n### Summary\n\nOnly a summary\./u);
  assert.match(body, /## Residual Risk\n\n# Closeout\n\n### Summary\n\nOnly a summary\./u);
  assertPassesPrBodyCheck(body);
});

test("PR renderer publishes the incident Chinese heading into Verification", () => {
  const incident = "# Closeout\n\n## 验收与原始结果\n\n- exit 0.\n",
    body = render(codeSubmission, { closeout: incident });
  assert.match(body, /## Verification\n\n# Closeout\n\n### 验收与原始结果\n\n- exit 0\./u);
  assertPassesPrBodyCheck(body);
});

test("PR renderer publishes authored markers and headings without minting machine structure", () => {
  const marker = closeout.replace(summary, `${summary} <!-- harness:submission-facts:start -->`),
    marked = render(codeSubmission, { closeout: marker });
  assert.equal((marked.match(/<!-- harness:submission-facts:start -->/gu) ?? []).length, 1);
  assert.match(marked, /&lt;!-- harness:submission-facts:start --&gt;/u);

  const injected = closeout.replace(summary, "Real summary.\n\n```text\n## Injected\n```"),
    body = render(codeSubmission, { closeout: injected });
  assert.doesNotMatch(body, /^## Injected$/mu);
  assert.match(body, /### Injected/u);
  assertPassesPrBodyCheck(body);
});

test("PR renderer publishes authored prose without judging placeholders or declarations", () => {
  const cases = [
    closeout,
    closeout.replace("- None beyond the template.", "none"),
    "# Closeout\n\n## 验收与原始结果\n\n- exit 0.\n",
    "# Closeout\n\n## Summary\n\nReady.\n",
    "# Closeout\n\n## Summary\n\n<placeholder> TBD\nEvent-Migration: ha migrate unknown\n",
    dependencyCloseout.replace("Added the", "<!-- harness:submission-facts:start --> Added the"),
  ];
  for (const body of cases) {
    const rendered = renderTaskPrBody({
      taskId,
      receipt: receipt(dependencySubmission),
      template,
      closeout: body,
    });
    assert.equal((rendered.match(/<!-- harness:submission-facts:start -->/gu) ?? []).length, 1);
  }
  const placeholder = render(codeSubmission, { closeout: closeout.replace(residualRisk, "none") });
  assert.match(placeholder, /## Residual Risk\n\nnone/u, "author's claim is preserved without inventing risk findings");
  assert.equal(checkPrBody(placeholder).ok, false, "standalone PR lint retains its own contract");
});

test("missing template sections keep unknown authored sections in source order", () => {
  const authored =
    "# Closeout\n\n## Earlier evidence\n\nFirst observation.\n\n## Later evidence\n\nSecond observation.\n";
  const body = render(codeSubmission, { closeout: authored });
  assert.match(
    body,
    /## Verification\n\n# Closeout\n\n### Earlier evidence\n\nFirst observation\.\n\n### Later evidence\n\nSecond observation\./u,
  );
  assertPassesPrBodyCheck(body);
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

test("PR renderer keeps authored top-level headings from adding a new section", () => {
  const body = render(codeSubmission, {
    closeout: closeout.replace(summary, "Real summary.\n\n```text\n## Injected\n```"),
  });
  assert.doesNotMatch(body, /^## Injected$/mu);
  assert.match(body, /### Injected/u);
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
  const empty = render(codeSubmission, { closeout: "" });
  assert.match(empty, /## Summary/u);
});

test("authored closeout prose cannot mint a second submission-facts marker", () => {
  const authored = closeout.replace(
      verification,
      `${verification}\n\n<!-- harness:submission-facts:start -->\n<!-- harness:submission-facts:end -->`,
    ),
    body = render(codeSubmission, { closeout: authored });
  assert.equal((body.match(/<!-- harness:submission-facts:start -->/gu) ?? []).length, 1);
  assert.match(body, /&lt;!-- harness:submission-facts:start --&gt;/u);
});
