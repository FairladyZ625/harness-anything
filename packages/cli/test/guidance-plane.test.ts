// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskCreateGuidance } from "../../daemon/src/receipt-guidance.ts";
import { humanError, renderReceiptGuidance } from "../src/cli/guidance-plane.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("guidance plane renders all seven descriptor-derived task-create messages exactly", () => {
  const values = {
      taskId: "task-a",
      packagePath: "tasks/task-a",
      outputShape: "repository-diff",
      dryRun: true,
      opId: "op-a",
      canonicalVisible: false,
    },
    guidance = taskCreateGuidance(values),
    receipt = (dryRun: boolean, canonicalVisible: boolean) => ({
      command: "task-create",
      dryRun,
      outputShape: "repository-diff",
      proof: { canonicalVisible },
      guidance,
    }),
    shared = [
      "contract: repository-diff requires a committable public-repository diff, real CI, and a code-doc reconciliation witness. For a task-package-only report or decision, use the task-package-artifact preset docs-task.",
      "plan: write the concrete plan at harness/tasks/task-a/task_plan.md",
      "agenda: use ha task pin task-a to pin it to the CEO agenda",
      "ledger: INDEX.md and closeout.md are coordinator-managed; update them through ha doc sync",
    ];
  assert.equal(guidance.length, 7);
  assert.deepEqual(renderReceiptGuidance(receipt(true, false)), [
    shared[0],
    "next: remove --dry-run to publish this exact resolved scaffold",
    ...shared.slice(1),
  ]);
  assert.deepEqual(renderReceiptGuidance(receipt(false, true)), [
    shared[0],
    "next: edit tasks/task-a/task_plan.md, then run ha task start task-a --execution-id <id>",
    ...shared.slice(1),
  ]);
  assert.deepEqual(renderReceiptGuidance(receipt(false, false)), [
    shared[0],
    "next: ha receipt show op-a",
    ...shared.slice(1),
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

test("write_rejected renders the inner receipt reason and summary without suggesting a retry", () => {
  assert.deepEqual(
    renderCliReceipt({
      ok: false,
      command: "squad-run",
      code: "write_rejected",
      rejectionExplanation:
        'The inner receipt outcome "running" is not a declared write outcome; inspect the producing action instead of retrying it.',
      summary: "squad-run debug-squad: squad_0123456789abcdef01234567",
      error: { code: "write_rejected" },
    }),
    {
      stream: "stderr",
      text:
        'error code=write_rejected hint=The inner receipt outcome "running" is not a declared write outcome; ' +
        "inspect the producing action instead of retrying it. Inner receipt: " +
        "squad-run debug-squad: squad_0123456789abcdef01234567",
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

test("task show renders lifecycle status before the secondary graph cursor", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "task-show",
    evidence: JSON.stringify({ task: { status: "done", currentNode: "review" } }),
    summary: "task: status=done currentNode=review",
  });
  assert.equal(rendered.stream, "stdout");
  assert.deepEqual(rendered.text.split("\n").slice(0, 2), ["status: done", "graph cursor: review"]);
});
