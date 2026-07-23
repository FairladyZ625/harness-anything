// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { coreFailureRegistry } from "../../api-contracts/src/honest-receipt-outcome.ts";
import {
  compoundReceiptSchema,
  projectCompoundReceiptEnvelope,
  type CommandReceipt,
  type CompoundOperationReceipt
} from "../../application/src/index.ts";
import { renderReceiptText } from "../src/cli/receipt.ts";

test("honest sidecar leaves legacy command receipt text rendering byte-identical", () => {
  const commandReceipt: CommandReceipt = {
    ok: true,
    schema: "command-receipt/v2",
    command: "task show",
    entity: { kind: "task", id: "task-s2" },
    action: "show",
    summary: "completed task show",
    warnings: ["legacy warning"],
    details: { data: { taskId: "task-s2" } },
    meta: {
      generatedAt: "2026-07-23T00:00:00.000Z",
      compatibility: {
        legacyReceipt: "CommandReceipt/v1",
        legacyReport: "task-show-report/v1"
      }
    }
  };
  const compoundReceipt: CompoundOperationReceipt = {
    schema: compoundReceiptSchema,
    workspaceId: "workspace-s2",
    viewId: "view-s2",
    opId: "op-s2",
    waiterId: "waiter-s2",
    resultToken: "token-s2",
    phase: "PENDING",
    delivery: "PENDING",
    currentLease: "NOT_REQUESTED",
    sequence: 0,
    updatedAt: "2026-07-23T00:00:00.000Z"
  };
  const before = Buffer.from(renderReceiptText(commandReceipt), "utf8");

  projectCompoundReceiptEnvelope(compoundReceipt, coreFailureRegistry);

  const after = Buffer.from(renderReceiptText(commandReceipt), "utf8");
  assert.equal(before.equals(after), true);
  assert.equal(commandReceipt.ok, true);
  assert.deepEqual(commandReceipt.warnings, ["legacy warning"]);
});
