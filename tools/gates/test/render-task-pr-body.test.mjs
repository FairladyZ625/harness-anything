// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { renderTaskPrBody } from "../render-task-pr-body.mjs";

const taskId = "task-private-example",
  firstSha = "1".repeat(40),
  commitSha = "2".repeat(40),
  baseSha = "3".repeat(40),
  marker = "<!-- harness:submission-facts:start -->\n<!-- harness:submission-facts:end -->";

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

test("PR renderer uses the current frozen submission and updates its fact block", () => {
  const submission = {
      commitSha,
      deliverables: ["legacy/deliverable-only.ts"],
      changedFiles: ["packages/kernel/a.ts", "docs/change.md", "packages/old.ts"],
      outputs: ["Deleted-Production-Paths: packages/old.ts"],
      productionDelta: { baseSha, added: 5, deleted: 2, changed: [], unclassified: [] },
    },
    initial = renderTaskPrBody({
      taskId,
      receipt: receipt(submission),
      template: `# PR\n\n${marker}\n`,
      headSha: commitSha,
    }),
    refreshed = renderTaskPrBody({
      taskId,
      receipt: receipt({ ...submission, productionDelta: { ...submission.productionDelta, added: 8 } }),
      template: initial,
      headSha: commitSha,
    });
  assert.match(refreshed, new RegExp(`Delivery commit: \\x60${commitSha}\\x60`, "u"));
  assert.match(refreshed, new RegExp(`Merge base: \\x60${baseSha}\\x60`, "u"));
  assert.match(refreshed, /Production delta: \+8\/-2 \(net \+6\)/u);
  assert.match(refreshed, /docs\/change\.md/u);
  assert.match(refreshed, /packages\/old\.ts/u, "deleted paths come from the complete changedFiles list");
  assert.doesNotMatch(refreshed, /legacy\/deliverable-only\.ts/u);
  assert.equal((refreshed.match(/## Delivery Facts/gu) ?? []).length, 1);
  assert.doesNotMatch(refreshed, new RegExp(taskId, "u"), "private task ids are not emitted into the public body");
});

test("PR renderer labels artifact-only submissions without inventing commit facts", () => {
  const body = renderTaskPrBody({
    taskId,
    receipt: receipt({ commitSha: null, deliverables: ["tasks/private/artifacts/report.md"], outputs: [] }),
    template: `# PR\n\n${marker}\n`,
  });
  assert.match(body, /artifact-only; no public Git commit/u);
  assert.match(body, /Delivered artifacts: 1 center-accepted artifact/u);
  assert.doesNotMatch(
    body,
    /tasks\/private\/artifacts\/report\.md/u,
    "private artifact paths stay out of public PR text",
  );
  assert.doesNotMatch(body, /Merge base|Production delta/u);
});

test("PR renderer keeps unusual file paths on one literal Markdown line", () => {
  const filePath = "src/backtick`and\n- injected.md",
    body = renderTaskPrBody({
      taskId,
      receipt: receipt({
        commitSha,
        deliverables: [],
        changedFiles: [filePath],
        outputs: [],
        productionDelta: { baseSha, added: 0, deleted: 0, changed: [], unclassified: [filePath] },
      }),
      template: `# PR\n\n${marker}\n`,
      headSha: commitSha,
    });
  assert.match(body, /  - ``"src\/backtick`and\\n- injected\.md"``/u);
  assert.doesNotMatch(body, /src\/backtick`and\n- injected/u);
});

test("PR renderer labels legacy facts, rejects stale HEAD, and rejects broken markers", () => {
  const submission = { commitSha, deliverables: [], changedFiles: [], outputs: [] };
  const legacy = renderTaskPrBody({
    taskId,
    receipt: receipt({
      commitSha,
      deliverables: ["README.md", "packages/kernel/old.ts"],
      outputs: ["Deleted-Production-Paths: packages/kernel/retired.ts"],
    }),
    template: `# PR\n\n${marker}`,
    headSha: commitSha,
  });
  assert.match(legacy, /Legacy submission facts/u);
  assert.match(legacy, /Production delta: unavailable on this legacy cut/u);
  assert.match(legacy, /README\.md/u);
  assert.match(legacy, /packages\/kernel\/retired\.ts/u);
  assert.doesNotMatch(legacy, /amend the submission/u);
  assert.throws(
    () =>
      renderTaskPrBody({
        taskId,
        receipt: receipt({ ...submission, productionDelta: { baseSha, added: 0, deleted: 0, unclassified: [] } }),
        template: `# PR\n\n${marker}`,
        headSha: firstSha,
      }),
    /HEAD differs/u,
  );
  assert.throws(() => renderTaskPrBody({ taskId, receipt: receipt(submission), template: "# PR\n" }), /marker pair/u);
});
