// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { DocSyncSubmitResultV1 } from "@harness-anything/application";
import { buildDocSyncCommandReceipt } from "../src/composition/doc-sync-command-receipt.ts";

test("empty doc-sync is a final no-op and never claims session durability", () => {
  const result: Extract<DocSyncSubmitResultV1, { readonly ok: true }> = {
    ok: true,
    schema: "daemon.doc-sync-submit-result/v1",
    status: "accepted",
    intentId: "intent-no-op",
    baseLedgerSha: "a".repeat(40),
    appliedLedgerSha: "a".repeat(40),
    appliedChanges: []
  };

  const receipt = buildDocSyncCommandReceipt({
    result,
    sessionId: "session-no-op",
    acceptedAt: "2026-08-09T10:00:00.000Z"
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.settlement, undefined);
  assert.match(receipt.summary, /no changes|no-op/iu);
  assert.doesNotMatch(receipt.summary, /durably accepted|pending/iu);
});
