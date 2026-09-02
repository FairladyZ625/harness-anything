// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { humanError, renderReceiptGuidance } from "../src/cli/guidance-plane.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("guidance plane applies declarative conditions and owns task-create prose", () => {
  const receipt = {
    command: "task-create",
    dryRun: true,
    outputShape: "repository-diff",
    proof: { canonicalVisible: false },
    guidance: [
      { kind: "repository-diff-contract", args: {}, when: { outputShape: "repository-diff" } },
      { kind: "task-create-publish", args: {}, when: { dryRun: true } },
      {
        kind: "task-create-start",
        args: { packagePath: "tasks/task-a", taskId: "task-a" },
        when: { dryRun: false },
      },
      { kind: "edit-plan", args: { packagePath: "tasks/task-a" } },
      { kind: "pin-agenda", args: { taskId: "task-a" } },
      { kind: "ledger-managed", args: { fields: ["INDEX.md", "closeout.md"] } },
    ],
  };
  assert.deepEqual(renderReceiptGuidance(receipt), [
    "contract: repository-diff requires a committable public-repository diff, real CI, and a code-doc reconciliation witness. For a task-package-only report or decision, use the task-package-artifact preset docs-task.",
    "next: remove --dry-run to publish this exact resolved scaffold",
    "plan: write the concrete plan at harness/tasks/task-a/task_plan.md",
    "agenda: use ha task pin task-a to pin it to the CEO agenda",
    "ledger: INDEX.md and closeout.md are coordinator-managed; update them through ha doc sync",
  ]);
});

test("failure guidance renders structured missing-section, validator, and workspace diagnostics", () => {
  assert.match(
    humanError({
      code: "plan_placeholder",
      diagnostic: {
        kind: "missing-sections",
        documentPath: "tasks/task-a/task_plan.md",
        diskDiffers: false,
        missingSections: [{ section: "Goal", reason: "scaffold", retainedScaffold: "Describe the result." }],
      },
    }).hint,
    /Goal: still contains scaffold text.*ha doc sync --submit --path tasks\/task-a\/task_plan\.md/su,
  );
  assert.equal(
    humanError({
      code: "invalid_result",
      diagnostic: {
        kind: "validation",
        entity: "task-a",
        field: "status",
        actual: "weird",
        expectation: "must be planned",
      },
    }).hint,
    "Validation failed for entity=task-a field=status; actual=weird; must be planned.",
  );
  assert.equal(
    humanError({
      code: "invalid_command",
      diagnostic: { kind: "workspace-boundary", field: "fromFile", workspaceRoot: "/repo" },
    }).hint,
    "fromFile must name a readable UTF-8 file inside workspace root /repo.",
  );
  assert.deepEqual(
    renderCliReceipt({
      ok: false,
      code: "invalid_command",
      diagnostic: {
        kind: "invalid-enum",
        field: "verdict",
        actual: "approve",
        allowedValues: ["approved", "changes_requested", "dismissed"],
      },
    }),
    {
      stream: "stderr",
      text: "error code=invalid_command hint=verdict must be one of approved, changes_requested, dismissed; received approve.",
    },
  );
});

test("receipt registry preserves migrated family goldens", () => {
  assert.deepEqual(renderCliReceipt({ command: "runtime-batch", dispatches: [] }), {
    stream: "stdout",
    text: "No batch dispatches.",
  });
  assert.deepEqual(renderCliReceipt({ ok: true, command: "doc-show", evidence: "document body" }), {
    stream: "stdout",
    text: "document body",
  });
  assert.deepEqual(renderCliReceipt({ ok: true, command: "migrate-import", summary: "migration preview" }), {
    stream: "stdout",
    text: "migration preview",
  });
  assert.deepEqual(
    renderCliReceipt({
      ok: true,
      command: "init",
      summary: "initialized harness",
      outcome: "noop",
      created: [],
      updated: [],
      preserved: ["harness/harness.yaml"],
      drifted: [],
      commit: null,
      next: "ha task create --title <title>",
    }),
    {
      stream: "stdout",
      text: [
        "initialized harness",
        "outcome: noop",
        "created: []",
        "updated: []",
        'preserved: ["harness/harness.yaml"]',
        "drifted: []",
        "commit: none",
        "next: ha task create --title <title>",
      ].join("\n"),
    },
  );
  assert.deepEqual(
    renderCliReceipt({
      schema: "command-receipt/v2",
      ok: true,
      command: "schedule-list",
      outcome: "applied",
      evidence: JSON.stringify({ schema: "schedule-list/v1", schedules: [] }),
    }),
    { stream: "stdout", text: "No schedules." },
  );
});
