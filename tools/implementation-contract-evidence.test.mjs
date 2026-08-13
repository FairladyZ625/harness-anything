// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { eventStoreEvidence, missingEventStoreEvidence } from "./implementation-contract-evidence.mjs";

test("W1 unified-cut evidence replaces the event-only HEAD-preservation fixture", () => {
  const current = eventStoreEvidence.join("\n");
  assert.deepEqual(missingEventStoreEvidence(current, ""), []);
  const stale = current.replace(
    "advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte",
    "object/ref-only publication preserves HEAD, index, prose, and every dirty path byte"
  );
  assert.deepEqual(missingEventStoreEvidence(stale, ""), [
    "advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte"
  ]);
});
