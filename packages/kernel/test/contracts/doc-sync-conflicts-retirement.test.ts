// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DOC_POLICY_ID, decideDocWrite, validateCurrentDocEvent } from "../../src/domain/doc-sync.contract.ts";
import { validateWriteReceipt } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

import { actor, baseLedgerSha, claim, currentLedgerSha, decide, state } from "./doc-sync.fixtures.ts";
test("stale ledger and stale blob reject the entire batch with current holder and typed conflict detail", () => {
  const body = "# Notes\nA\n",
    change = {
      path: "context/notes.md",
      baseBlobSha256: sha256Text(body),
      policyId: DOC_POLICY_ID,
      candidate: claim(`${body}B\n`),
    } as const;
  const staleLedger = decide(change, state(body), Buffer.from(`${body}B\n`), {
    currentLedgerSha: {
      ...baseLedgerSha,
      headDigest: `sha256:${"b".repeat(64)}`,
    },
  });
  assert.equal(staleLedger.accepted, false);
  if (staleLedger.accepted) return;
  assert.equal(staleLedger.code, "base_ledger_changed");
  assert.equal(staleLedger.detail.holder?.personId, "person-owner");
  assert.equal(staleLedger.detail.paths[0]?.currentBlobSha256, sha256Text(body));
  assert.deepEqual(
    validateWriteReceipt({
      outcome: "op_rejected",
      opId: "doc-op",
      code: staleLedger.code,
      origin: "doc-sync-contract",
      evidence: `contract-rejection:${staleLedger.code}`,
      nextAction: staleLedger.detail.nextAction,
      detail: staleLedger.detail,
    }),
    [],
  );
  const staleBlob = decide({ ...change, baseBlobSha256: "c".repeat(64) }, state(body), Buffer.from(`${body}B\n`));
  assert.equal(staleBlob.accepted, false);
  if (!staleBlob.accepted) {
    assert.equal(staleBlob.code, "base_blob_changed");
    assert.equal(staleBlob.detail.holder?.version, 3);
  }
});

test("claim mismatch, deletion, heading rename, machine touch, and ambiguous headings fail closed", () => {
  const base = "# Notes\nA\n",
    additive = `${base}B\n`,
    change = {
      path: "context/notes.md",
      baseBlobSha256: sha256Text(base),
      policyId: DOC_POLICY_ID,
      candidate: claim(additive),
    } as const;
  const mismatch = decide(change, state(base), Buffer.from("wrong"));
  assert.equal(mismatch.accepted, false);
  if (!mismatch.accepted) assert.equal(mismatch.code, "content_claim_mismatch");
  const deletion = decide({ ...change, candidate: null }, state(base), null);
  assert.equal(deletion.accepted, false);
  if (!deletion.accepted) {
    assert.equal(deletion.code, "deletion_forbidden");
    assert.equal(deletion.detail.deletions[0]?.source, "intent");
  }
  for (const candidate of ["# Renamed\nA\n", "---\nowner: other\n---\n# Notes\nA\n", "# Same\nA\n# Same\nB\n"]) {
    const current = candidate.startsWith("---") ? "---\nowner: owner\n---\n# Notes\nA\n" : base,
      rejected = decide(
        {
          path: "context/notes.md",
          baseBlobSha256: sha256Text(current),
          policyId: DOC_POLICY_ID,
          candidate: claim(candidate),
        },
        state(current),
        Buffer.from(candidate),
      );
    assert.equal(rejected.accepted, false, candidate);
    if (!rejected.accepted) {
      assert.equal(rejected.code, "unresolved_touch");
      assert.equal(rejected.detail.unresolvedTouches.length > 0, true);
    }
  }
});

test("an explicit single-document retirement records its reason and declares the audited delete target", () => {
  const base = "# Temporary\n\nRetire me.\n",
    document = state(base),
    intent = {
      schema: "doc-write-intent/v1" as const,
      executionId: null,
      baseLedgerSha,
      changes: [
        {
          path: document.path,
          baseBlobSha256: document.blobSha256,
          policyId: document.policyId,
          candidate: null,
        },
      ],
    };
  const result = decideDocWrite({
    intent,
    opId: "doc-retire-op",
    eventId: "doc-retire-event",
    workspaceRevision: 3,
    actor,
    source: "local",
    occurredAt: "2026-08-12T11:00:00.000Z",
    currentLedgerSha,
    lease: null,
    authorizationDecision: null,
    documents: [document],
    claims: [null],
    retirementReason: "superseded temporary evidence",
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.event.payload.retirementReason, "superseded temporary evidence");
  assert.equal(result.event.payload.changes[0]?.candidate, null);
  assert.deepEqual(validateCurrentDocEvent(result.event), []);
  assert.deepEqual(
    result.plan.targets.filter((target) => target.kind === "authored_file_delete"),
    [
      {
        kind: "authored_file_delete",
        path: document.path,
        operation: "delete",
        baseSha256: document.blobSha256,
      },
    ],
  );
  const invalid = decideDocWrite({
    intent,
    opId: "doc-retire-invalid",
    eventId: "doc-retire-invalid-event",
    workspaceRevision: 3,
    actor,
    source: "local",
    occurredAt: "2026-08-12T11:00:00.000Z",
    currentLedgerSha,
    lease: null,
    authorizationDecision: null,
    documents: [document],
    claims: [null],
    retirementReason: "   ",
  });
  assert.equal(invalid.accepted, false);
  if (!invalid.accepted) assert.equal(invalid.code, "invalid_retirement");
});

test("direct CRLF claims name the line-ending repair when the contract rejects them", () => {
  const crlf = "# Notes" + String.fromCharCode(13) + "\nA" + String.fromCharCode(13) + "\n",
    result = decide(
      {
        path: "context/notes.md",
        baseBlobSha256: null,
        policyId: DOC_POLICY_ID,
        candidate: claim(crlf),
      },
      null,
      Buffer.from(crlf),
    );
  assert.equal(result.accepted, false);
  if (!result.accepted) {
    assert.equal(result.code, "unresolved_touch");
    assert.equal(result.detail.unresolvedTouches[0]?.reason, "claim is not canonical LF text");
    assert.match(result.detail.nextAction, /LF line endings.*resubmit/u);
  }
});

test("prose regression controls reject deletion and duplicate headings while naming missing and reordered base regions", () => {
  const base = "# One\nA\n# Two\nB\n",
    prose = {
      path: "context/notes.md",
      baseBlobSha256: sha256Text(base),
      policyId: DOC_POLICY_ID,
      candidate: claim(base),
    } as const;
  const deletion = decide({ ...prose, candidate: null }, state(base), null);
  assert.equal(deletion.accepted, false);
  if (!deletion.accepted) assert.equal(deletion.code, "deletion_forbidden");
  const duplicate = "# Same\nA\n# Same\nB\n",
    duplicateResult = decide({ ...prose, candidate: claim(duplicate) }, state(base), Buffer.from(duplicate));
  assert.equal(duplicateResult.accepted, false);
  if (!duplicateResult.accepted)
    assert.equal(duplicateResult.detail.unresolvedTouches[0]?.reason, "duplicate heading anchor");
  const missing = "# One\nA\n",
    missingResult = decide({ ...prose, candidate: claim(missing) }, state(base), Buffer.from(missing));
  assert.equal(missingResult.accepted, false);
  if (!missingResult.accepted)
    assert.equal(missingResult.detail.unresolvedTouches[0]?.reason, 'base region is missing: "# Two"');
  const allMissing = "Replacement prose.\n",
    allMissingResult = decide({ ...prose, candidate: claim(allMissing) }, state(base), Buffer.from(allMissing));
  assert.equal(allMissingResult.accepted, false);
  if (!allMissingResult.accepted)
    assert.equal(allMissingResult.detail.unresolvedTouches[0]?.reason, 'base regions are missing: "# One", "# Two"');
  const reordered = "# Two\nB\n# One\nA\n",
    reorderedResult = decide({ ...prose, candidate: claim(reordered) }, state(base), Buffer.from(reordered));
  assert.equal(reorderedResult.accepted, false);
  if (!reorderedResult.accepted)
    assert.equal(
      reorderedResult.detail.unresolvedTouches[0]?.reason,
      'base regions are reordered: candidate places "# Two" before "# One"; expected "# One" before "# Two"',
    );
});
