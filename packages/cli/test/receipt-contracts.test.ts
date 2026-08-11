// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { commandReceiptContractsByKind } from "../src/cli/receipt-contracts.ts";
import { toCommandReceipt } from "../src/cli/receipt.ts";

test("command receipts fail closed on undeclared path fields", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "task-show",
    taskId: "task_1",
    outcome: "applied",
    report: { outcome: "applied" },
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
    command: "task-complete",
    taskId: "task_1",
    executionId: "execution_1",
    outcome: "applied"
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
    command: "task-create",
    taskId: "task_1",
    outcome: "applied",
    report: { outcome: "applied" }
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.entity?.id, "task_1");
  assert.equal(receipt.details?.data && typeof receipt.details.data === "object" && "leaseCredential" in receipt.details.data, false);
});

test("command receipts accept explicitly optional declared data when present", () => {
  const receipt = toCommandReceipt({
    ok: true,
    command: "task-start",
    taskId: "task_1",
    executionId: "execution_1",
    outcome: "applied",
    opId: "task-start-op",
    revision: 2,
    nextAction: "Save it; submit requires it.",
    leaseCredential: "shown-once",
    leaseExpiry: "2026-08-11T01:00:00.000Z",
    report: { outcome: "applied" }
  });

  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.details?.data && typeof receipt.details.data === "object" && "leaseCredential" in receipt.details.data, true);
});

test("optional receipt contract fields carry non-empty absence reasons", () => {
  const optionalEntries = Object.entries(commandReceiptContractsByKind)
    .flatMap(([command, contract]) => [
      ...Object.entries(contract.optionalData ?? {}).map(([field, reason]) => ({ command, field: `data.${field}`, reason })),
      ...Object.entries(contract.optionalPaths ?? {}).map(([field, reason]) => ({ command, field: `paths.${field}`, reason }))
    ]);

  assert.equal(optionalEntries.every((entry) => entry.reason.trim().length > 0), true);
  assert.equal(optionalEntries.some((entry) => entry.command === "task-start" && entry.field === "data.leaseCredential"), true);
  assert.equal(optionalEntries.some((entry) => entry.command !== "task-start" && entry.field === "data.leaseCredential"), false);
  assert.equal(optionalEntries.some((entry) => ["new-task", "task-claim", "status-set"].includes(entry.command)), false);
});

test("command receipts accept declared success data and paths", () => {
  const completeReceipt = toCommandReceipt({
    ok: true,
    command: "task-complete",
    taskId: "task_1",
    executionId: "execution_1",
    outcome: "applied",
    report: { outcome: "applied" }
  });
  const presetReceipt = toCommandReceipt({
    ok: true,
    command: "preset-validate",
    preset: { id: "standard-task", version: "1.0.0" },
    report: { schema: "preset-validate-report/v1", issueCount: 0 }
  });

  assert.equal(completeReceipt.ok, true);
  assert.equal(presetReceipt.ok, true);
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
