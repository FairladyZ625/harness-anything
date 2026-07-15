// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { commandReceiptContractsByKind } from "../src/cli/receipt-contracts.ts";
import { renderReceiptText, toCommandReceipt } from "../src/cli/receipt.ts";

test("command receipts fail closed on undeclared path fields", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "task-delete",
    taskId: "task_1",
    mode: "soft",
    path: "soft"
  });

  assert.equal(receipt.ok, false);
  if (!receipt.ok) {
    assert.equal(receipt.error?.code, "command_receipt_contract_mismatch");
    assert.match(receipt.error?.hint ?? "", /paths\.primary/u);
  }
});

test("command receipts fail closed on undeclared command names", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "check:target-project",
    profile: "target-project",
    rows: 0
  });

  assert.equal(receipt.ok, false);
  if (!receipt.ok) {
    assert.equal(receipt.error?.code, "command_receipt_contract_mismatch");
    assert.match(receipt.error?.hint ?? "", /missing receipt contract/u);
  }
});

test("command receipts fail closed on undeclared success data", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "preset-validate",
    issues: []
  });

  assert.equal(receipt.ok, false);
  if (!receipt.ok) {
    assert.equal(receipt.error?.code, "command_receipt_contract_mismatch");
    assert.match(receipt.error?.hint ?? "", /data\.issues/u);
  }
});

test("command receipts fail closed on missing declared success data", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "task-archive",
    taskId: "task_1",
    status: "cancelled"
  });

  assert.equal(receipt.ok, false);
  if (!receipt.ok) {
    assert.equal(receipt.error?.code, "command_receipt_contract_mismatch");
    assert.match(receipt.error?.hint ?? "", /data\.report/u);
  }
});

test("command receipts fail closed on missing declared paths", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "decision-show",
    decisionId: "dec_MISSING_PATH",
    report: { schema: "decision-show-report/v1" }
  });

  assert.equal(receipt.ok, false);
  if (!receipt.ok) {
    assert.equal(receipt.error?.code, "command_receipt_contract_mismatch");
    assert.match(receipt.error?.hint ?? "", /paths\.primary/u);
  }
});

test("command receipts allow explicitly optional declared data to be absent", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "new-task",
    taskId: "task_1",
    slug: "task-1",
    status: "active",
    packagePath: "harness/tasks/task_1"
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.entity?.id, "task_1");
  assert.equal(receipt.paths?.some((entry) => entry.role === "package"), true);
});

test("materializer warnings use the receipt warning envelope instead of a duplicate data field", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "materializer-run",
    rows: 1,
    warnings: ["sessions/conflict: merge failed"],
    report: { branches: [], warnings: ["sessions/conflict: merge failed"] }
  });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  if (!receipt.ok) return;
  assert.deepEqual(receipt.warnings, ["sessions/conflict: merge failed"]);
  assert.equal("warnings" in (receipt.details?.data ?? {}), false);
});

test("plain text receipts prioritize pending materialization and print its next command", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "decision-propose",
    decisionId: "dec_pending",
    decisionState: "proposed",
    path: "harness/decisions/decision-dec_pending/decision.md",
    report: { schema: "decision-write-cli-report/v1", dryRun: false },
    warnings: [
      { code: "decision_body_empty", message: "Add a narrative." },
      {
        code: "pending_materialization",
        message: "Write is durable but not readable. Run: ha materializer run --json",
        nextCommand: "ha materializer run --json"
      }
    ]
  });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  if (!receipt.ok) return;
  assert.match(renderReceiptText(receipt), /pending materialization|not readable/iu);
  assert.match(renderReceiptText(receipt), /next="ha materializer run --json"/u);
});

test("command receipts accept explicitly optional declared data when present", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "new-task",
    taskId: "task_1",
    slug: "task-1",
    status: "active",
    preset: "standard-task",
    module: "kernel",
    generated: ["task_plan.md"],
    report: { schema: "new-task-report/v1" },
    packagePath: "harness/tasks/task_1"
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.details?.data && typeof receipt.details.data === "object" && "preset" in receipt.details.data, true);
});

test("optional receipt contract fields carry non-empty absence reasons", () => {
  const optionalEntries = Object.entries(commandReceiptContractsByKind)
    .flatMap(([command, contract]) => [
      ...Object.entries(contract.optionalData ?? {}).map(([field, reason]) => ({ command, field: `data.${field}`, reason })),
      ...Object.entries(contract.optionalPaths ?? {}).map(([field, reason]) => ({ command, field: `paths.${field}`, reason }))
    ]);

  assert.deepEqual(optionalEntries, [{
    command: "new-task",
    field: "data.preset",
    reason: "Only emitted when task creation runs through a selected preset."
  }, {
    command: "new-task",
    field: "data.module",
    reason: "Only emitted when --module is supplied or preset/module routing materializes module metadata."
  }, {
    command: "new-task",
    field: "data.generated",
    reason: "Only emitted when preset or template materialization produces generated files."
  }, {
    command: "new-task",
    field: "data.report",
    reason: "Only emitted when the creation path produces a structured creation report."
  }, {
    command: "task-claim",
    field: "data.executionId",
    reason: "Only emitted when a work claim opens a Holder V2 Execution round."
  }, {
    command: "status-set",
    field: "data.forced",
    reason: "Only emitted for audited cancellation recovery invoked with --force."
  }, {
    command: "status-set",
    field: "data.forceAudit",
    reason: "Only emitted for audited cancellation recovery that appends force audit evidence."
  }, {
    command: "status-set",
    field: "data.executionId",
    reason: "Only emitted for Holder V2 execution submission."
  }, {
    command: "status-set",
    field: "data.report",
    reason: "Only emitted for Holder V2 execution submission."
  }, {
    command: "status-set",
    field: "paths.primary",
    reason: "Only emitted for audited cancellation recovery where the audit progress path is returned as the primary path."
  }, {
    command: "status-set",
    field: "paths.forceAudit",
    reason: "Only emitted for audited cancellation recovery that appends force audit evidence."
  }, {
    command: "progress-append",
    field: "data.report",
    reason: "Only emitted when --evidence is supplied and the receipt includes the appended evidence payload."
  }, {
    command: "task-archive",
    field: "data.taskId",
    reason: "Present for single-task archive receipts."
  }, {
    command: "task-archive",
    field: "data.status",
    reason: "Present for single-task archive receipts."
  }, {
    command: "task-archive",
    field: "data.rows",
    reason: "Present for batch archive receipts."
  }, {
    command: "task-archive",
    field: "data.tasks",
    reason: "Present for batch archive receipts."
  }, {
    command: "task-supersede",
    field: "data.report",
    reason: "Only emitted when superseding by an existing replacement task via --by."
  }, {
    command: "task-supersede",
    field: "paths.package",
    reason: "Only emitted when supersede creates a new replacement task package."
  }, {
    command: "task-delete",
    field: "data.report",
    reason: "Only emitted when delete attribution such as --deleted-by is supplied."
  }, {
    command: "task-review",
    field: "data.completionGate",
    reason: "Only emitted by completion-oriented task gate results; ordinary task review emits the review contract only."
  }, {
    command: "task-complete",
    field: "data.report",
    reason: "Only emitted for completion paths that surface a review or gate report; clean completion emits reviewContract and completionGate."
  }, {
    command: "task-complete",
    field: "data.executionId",
    reason: "Only emitted when completion accepts a submitted Execution."
  }, {
    command: "task-complete",
    field: "data.reviewContract",
    reason: "Compatibility-only legacy review.md gate evidence; it never authorizes completion."
  }, {
    command: "decision-verify",
    field: "data.decisionId",
    reason: "Only emitted when verifying one decision; --all emits aggregate rows without a single decision id."
  }, {
    command: "session-sync",
    field: "paths.primary",
    reason: "Present when at least one legacy Session requires conversion."
  }, {
    command: "governance-rebuild",
    field: "data.generated",
    reason: "Only emitted for apply/archive rebuild modes that write generated governance views."
  }, {
    command: "preset-run",
    field: "data.rows",
    reason: "Only emitted when a scripted preset run writes a numeric rows value in its result."
  }, {
    command: "preset-run",
    field: "data.runId",
    reason: "Only emitted by the semantic script host for an executable v3 entrypoint."
  }, {
    command: "preset-run",
    field: "data.capabilityReceipt",
    reason: "Only emitted by v3 semantic execution with its exact provider bindings."
  }, {
    command: "preset-action",
    field: "data.rows",
    reason: "Only emitted when a scripted preset action writes a numeric rows value in its result."
  }, {
    command: "preset-action",
    field: "data.runId",
    reason: "Only emitted by the semantic script host for an executable v3 entrypoint."
  }, {
    command: "preset-action",
    field: "data.capabilityReceipt",
    reason: "Only emitted by v3 semantic execution with its exact provider bindings."
  }, {
    command: "script-run",
    field: "data.rows",
    reason: "Only emitted when a script writes a numeric rows value in its script-result/v1 payload."
  }]);
  assert.equal(optionalEntries.every((entry) => entry.reason.trim().length > 0), true);
});

test("command receipts accept declared success data and paths", () => {
  const deleteReceipt = toCommandReceipt({
    ok: true,
    command: "task-delete",
    taskId: "task_1",
    mode: "soft",
    report: { schema: "task-delete-report/v1" }
  });
  const presetReceipt = toCommandReceipt({
    ok: true,
    command: "preset-validate",
    preset: { id: "standard-task", version: "1.0.0" },
    report: { schema: "preset-validate-report/v1", issueCount: 0 }
  });

  assert.equal(deleteReceipt.ok, true);
  assert.equal(presetReceipt.ok, true);
});

test("preset list text renders id, title, and description rows", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "preset-list",
    presets: [{
      id: "standard-task",
      title: "Standard Task",
      description: "Handle general implementation and maintenance work."
    }],
    issues: []
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(
    renderReceiptText(receipt),
    "standard-task — Standard Task — Handle general implementation and maintenance work."
  );
});

test("command receipts expose v2 shallow fields and user-facing command names", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "runtime-event-list",
    rows: 1,
    path: "harness/events/runtime-events.jsonl",
    report: {
      schema: "runtime-event-ledger-cli-report/v1",
      items: [{ eventId: "evt_1", kind: "interrupt" }]
    }
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.schema, "command-receipt/v2");
  assert.equal(receipt.command, "event list");
  assert.equal(receipt.action, "list");
  assert.equal(receipt.rows, 1);
  assert.deepEqual(receipt.items, [{ eventId: "evt_1", kind: "interrupt" }]);
  assert.equal("runtime-event-append" in receipt, false);
});

test("graph receipts expose the generated HTML path and shallow edge count", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "graph",
    rows: 42,
    path: ".harness/generated/graph-panorama/index.html",
    projectionPath: ".harness/cache/projections.sqlite",
    report: {
      schema: "graph-panorama-report/v1",
      outputPath: ".harness/generated/graph-panorama/index.html",
      projectionPath: ".harness/cache/projections.sqlite",
      summary: { edges: 42, activeEdges: 42, coverageRows: 3, uncoveredClaims: 1, islands: 2 },
      statusCounts: { covered: 2, uncovered: 1 },
      islands: []
    }
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.command, "graph");
  assert.equal(receipt.rows, 42);
  assert.equal(receipt.paths?.some((entry) => entry.role === "primary" && entry.path.endsWith("index.html")), true);
  assert.equal(receipt.paths?.some((entry) => entry.role === "projection" && entry.path.endsWith("projections.sqlite")), true);
});
