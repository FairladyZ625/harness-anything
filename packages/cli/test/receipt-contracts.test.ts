import assert from "node:assert/strict";
import test from "node:test";
import { toCommandReceipt } from "../src/cli/receipt.ts";

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

test("command receipts accept declared success data and paths", () => {
  const deleteReceipt = toCommandReceipt({
    ok: true,
    command: "task-delete",
    taskId: "task_1",
    mode: "soft"
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
