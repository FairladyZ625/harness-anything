// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWorkspaceText } from "../../daemon/src/workspace-text-port.ts";
import { diagnosticForError, taskCreateGuidance } from "../../daemon/src/receipt-guidance.ts";
import { humanError, renderReceiptGuidance } from "../src/cli/guidance-plane.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("missing workspace packets identify the root used for relative paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-packet-root-"));
  try {
    mkdirSync(path.join(root, "harness"));
    writeFileSync(path.join(root, "harness/input.json"), "{}");
    assert.equal(readWorkspaceText(root, "harness/input.json", "fromFile"), "{}");
    assert.equal(readWorkspaceText(root, path.join(root, "harness/input.json"), "fromFile"), "{}");
    assert.throws(
      () => readWorkspaceText(root, "input.json", "fromFile"),
      (error: Error) => {
        const hint = humanError({ code: "invalid_command", rejectionExplanation: error.message }).hint;
        assert.ok(hint.includes(root), hint);
        assert.match(hint, /relative paths are resolved from this root/u);
        return true;
      },
    );
    writeFileSync(path.join(root, "invalid.json"), Buffer.from([0xff]));
    assert.throws(() => readWorkspaceText(root, "invalid.json", "fromFile"), /readable UTF-8/u);
    assert.throws(() => readWorkspaceText(root, "../outside.json", "fromFile"), /outside the workspace boundary/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful Decision proposals point to the canonical action explanation", () => {
  const receipt = {
    ok: true,
    command: "decision-propose",
    summary: "Decision proposed",
    evidence: JSON.stringify({ decisionId: "dec_example", state: "proposed" }),
  };
  assert.deepEqual(renderCliReceipt(receipt), {
    stream: "stdout",
    text: "Decision proposed\nnext: ha explain decision/dec_example",
  });
  assert.equal(renderCliReceipt({ ...receipt, ok: false, code: "invalid_command" }).stream, "stderr");
  assert.equal(renderCliReceipt({ ...receipt, command: "decision-show" }).text, "Decision proposed");
});

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
      "plan: write the concrete plan at harness/tasks/task-a/task_plan.md; required sections: Brief, Goal, " +
        "Context, Required Reading, Entry Conditions, Dependencies, Execution Surface, Constraints, Checkpoint, " +
        "CI/Gate Authority Stop Condition, Implementation Plan, Deliverable Contract, Evidence Protocol, " +
        "Verification",
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
    "fromFile must name a readable UTF-8 file inside workspace root /repo; for example " +
      "harness/tasks/<task-id>/artifacts/input.md.",
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

test("a rejected receipt's own explanation replaces the generic code-only hint", () => {
  assert.equal(
    humanError({
      code: "preset_snapshot_mismatch",
      diagnostic: { kind: "failure", code: "preset_snapshot_mismatch" },
      rejectionExplanation: "Run ha preset upgrade task-a before completion.",
    }).hint,
    "Run ha preset upgrade task-a before completion.",
  );
  assert.deepEqual(
    renderCliReceipt({
      ok: false,
      code: "invalid_proof",
      diagnostic: { kind: "failure", code: "invalid_proof" },
      rejectionExplanation:
        "CI run 34491684357 tested a1b2c3; this execution submitted d4e5f6. Use an observation for the submitted commit.",
    }),
    {
      stream: "stderr",
      text:
        "error code=invalid_proof hint=CI run 34491684357 tested a1b2c3; this execution submitted d4e5f6. " +
        "Use an observation for the submitted commit.",
    },
  );
  // A richer structured diagnostic still wins over a plain rejectionExplanation string.
  assert.equal(
    humanError({
      code: "invalid_result",
      diagnostic: { kind: "validation", entity: "task-a", field: "status", actual: "weird", expectation: "planned" },
      rejectionExplanation: "generic wrapper text",
    }).hint,
    "Validation failed for entity=task-a field=status; actual=weird; planned.",
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

test("fact_type_unregistered guides registering the domain type before retry", () => {
  assert.deepEqual(
    renderCliReceipt({ ok: false, code: "fact_type_unregistered", error: { code: "fact_type_unregistered" } }),
    {
      stream: "stderr",
      text:
        "error code=fact_type_unregistered hint=Fact domain types must be registered before use; " +
        "run ha fact type register <type> --source <source>, then retry this command.",
    },
  );
});

test("fact_type_unregistered renders the daemon explanation so the legal values reach the operator", () => {
  assert.deepEqual(
    renderCliReceipt({
      ok: false,
      code: "fact_type_unregistered",
      rejectionExplanation: "Fact domain type observation is not registered. Registered: verification.",
      error: { code: "fact_type_unregistered" },
    }),
    {
      stream: "stderr",
      text:
        "error code=fact_type_unregistered hint=Fact domain type observation is not registered. " +
        "Registered: verification. Run ha fact type register <type> --source <source>, then retry this command.",
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
      evidence: "schedule-list:0",
      schedules: [],
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

test("relation rejection renders structured triples and preserves them through diagnostic validation", () => {
  const diagnostic = {
    kind: "validation",
    entity: "relation",
    field: "source-ref/type/target-ref",
    actual: "fact --derives--> decision",
    expectation: "Choose a declared triple for source kind fact",
    allowedTriples: [{ sourceKind: "fact", type: "supersedes-fact", targetKind: "fact" }],
  };
  assert.deepEqual(diagnosticForError({ diagnostic }), diagnostic);
  const { allowedTriples: _triples, ...plainDiagnostic } = diagnostic;
  assert.deepEqual(diagnosticForError({ diagnostic: plainDiagnostic }), plainDiagnostic);
  const rendered = renderCliReceipt({ ok: false, code: "relation_triple_undeclared", diagnostic });
  assert.equal(rendered.stream, "stderr");
  assert.match(rendered.text, /source kind\ttype\ttarget kind\nfact\tsupersedes-fact\tfact/u);
  assert.doesNotMatch(rendered.text, /ha relation triples/u);
  assert.match(renderCliReceipt({ ok: false, diagnostic: { ...diagnostic, allowedTriples: [] } }).text, /\n\(none\)$/u);
  for (const allowedTriples of [
    null,
    {},
    [{ sourceKind: "fact", type: "relates" }],
    [{ sourceKind: "fact", type: "relates", targetKind: "fact", extra: true }],
  ]) {
    assert.equal(diagnosticForError({ diagnostic: { ...diagnostic, allowedTriples } }), undefined);
  }
});

test("daemon-coded rejection messages reach the CLI hint verbatim for submit and complete", () => {
  const submitMessage =
      "Delivery cut contains no changed paths; publish harness/tasks/task-1/artifacts/ " +
      "or name artifact:path@revision anchors in Summary.",
    submit = renderCliReceipt({
      schema: "command-receipt/v2",
      ok: false,
      command: "task-submit",
      outcome: "op_rejected",
      opId: "op_submit",
      code: "document_invalid",
      origin: "daemon",
      evidence: "rejection:document_invalid",
      diagnostic: { kind: "failure", code: "document_invalid" },
      rejectionExplanation: submitMessage,
      error: { code: "document_invalid" },
    });
  assert.equal(submit.stream, "stderr");
  assert.match(submit.text, /error code=document_invalid hint=/u);
  assert.ok(submit.text.includes(submitMessage), submit.text);
  const completeMessage = "CI receipt cannot support completion: evidence executionId is not the current execution.",
    complete = renderCliReceipt({
      schema: "command-receipt/v2",
      ok: false,
      command: "task-complete",
      outcome: "op_rejected",
      opId: "op_complete",
      code: "invalid_proof",
      origin: "daemon",
      evidence: "rejection:invalid_proof",
      diagnostic: { kind: "failure", code: "invalid_proof" },
      rejectionExplanation: completeMessage,
      error: { code: "invalid_proof" },
    });
  assert.equal(complete.stream, "stderr");
  assert.ok(complete.text.includes(completeMessage), complete.text);
});
