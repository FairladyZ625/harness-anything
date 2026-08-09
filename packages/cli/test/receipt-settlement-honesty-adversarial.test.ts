// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommandFailureReceipt,
  CommandReceipt,
  CommandReceiptSettlement
} from "@harness-anything/application";
import { renderReceiptText } from "../src/cli/receipt.ts";
import { normalizeDocSyncSubmitReceipt } from "../src/daemon/client.ts";

const pending: Extract<
  CommandReceiptSettlement,
  { readonly canonicalVisibility: "pending" }
> = {
  schema: "command-receipt-settlement/v1",
  receiptId: "repo-write-direct:op-accepted",
  durability: "session-durable",
  canonicalVisibility: "pending",
  acceptedAt: "2026-08-09T10:00:00.000Z",
  sessionId: "session-accepted",
  acceptedCommitSha: "a".repeat(40),
  authorityOperationIds: ["op-accepted"],
  statusQuery: {
    method: "repo.write.receipt.status",
    command: "ha receipt status repo-write-direct:op-accepted --json",
    receiptId: "repo-write-direct:op-accepted"
  }
};

test("plain-text pending success must not present canonical completion", () => {
  const receipt: CommandReceipt = {
    ok: true,
    schema: "command-receipt/v2",
    command: "repo.doc.sync.submit",
    action: "submit",
    summary: "completed repo.doc.sync.submit. Write is durably accepted; canonical settlement is pending.",
    settlement: pending,
    next: [],
    details: {},
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };

  const rendered = renderReceiptText(receipt);
  assert.match(rendered, /^pending\b/u);
  assert.match(rendered, /ha receipt status repo-write-direct:op-accepted --json/u);
  assert.doesNotMatch(rendered, /\bcompleted\b/iu);
});

test("plain-text command failure must disclose a partially accepted write before replay advice", () => {
  const receipt: CommandFailureReceipt = {
    ok: false,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "command failed after a durable write was accepted",
    error: {
      code: "later_stage_failed",
      hint: "Retry the original command."
    },
    settlement: pending,
    next: [{
      command: "ha task create --title repeated",
      description: "Retry the original command."
    }],
    details: {},
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };

  const rendered = renderReceiptText(receipt);
  assert.match(rendered, /durably accepted|session-durable/iu);
  assert.match(rendered, /ha receipt status repo-write-direct:op-accepted --json/u);
});

test("new CLI fails closed when an old doc-sync daemon omits settlement truth", () => {
  const legacySessionOnly = {
    ok: true,
    schema: "command-receipt/v2",
    command: "repo.doc.sync.submit",
    action: "doc.sync.submit",
    summary: "completed repo.doc.sync.submit",
    next: [],
    details: {
      data: {
        ok: true,
        schema: "daemon.doc-sync-submit-result/v1",
        status: "accepted",
        intentId: "intent-old-daemon",
        baseLedgerSha: "b".repeat(40),
        appliedLedgerSha: "a".repeat(40),
        appliedChanges: [{ path: "tasks/task_A/INDEX.md" }]
      }
    },
    meta: {
      generatedAt: "2026-08-09T10:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  } as const;

  const normalized = normalizeDocSyncSubmitReceipt(legacySessionOnly);

  assert.equal(normalized.ok, false);
  assert.equal(normalized.ok ? undefined : normalized.error?.code, "write_rejected");
  assert.match(normalized.summary, /may already have taken effect|落定状态未协商/iu);
  assert.doesNotMatch(renderReceiptText(normalized), /\bcompleted\b/iu);
});
