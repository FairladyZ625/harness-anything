// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  DocSyncJournalFailure,
  docSyncWriteFailure,
} from "../src/service/doc-sync-journal-failure.ts";

const request = {
  repo: { repoId: "canonical" },
  payload: {
    baseLedgerSha: "base",
    intentId: "intent-journal-unavailable",
    declaredIntent: "prose-edit" as const,
    changes: []
  }
};

test("doc sync preserves the journal throw site and classifies coordinator failure", () => {
  const journalCause = new Error("writer capsule rejected parent-owned journal flush");
  const result = docSyncWriteFailure(request, new DocSyncJournalFailure({
    _tag: "JournalUnavailable",
    cause: journalCause
  }));
  assert.equal(result?.ok, false);
  if (!result || result.ok) assert.fail("expected a doc-sync journal rejection");
  assert.equal(result._tag, "JournalUnavailable");
  assert.equal(result.code, "journal_unavailable");
  assert.equal(result.retryable, true);
  assert.match(result.reason, /writer capsule rejected parent-owned journal flush/u);
  assert.match(result.reason, /doc-sync-journal-failure\.test\.ts/u);
  assert.doesNotMatch(result.reason, /"cause":\{\}/u);
});
