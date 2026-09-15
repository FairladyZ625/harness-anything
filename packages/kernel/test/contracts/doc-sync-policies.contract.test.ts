// harness-test-tier: contract
import { rejectedAcceptance } from "./receipt-acceptance.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import {
  DOC_POLICY_ID,
  decideDocWrite,
  docRegionPolicyRegistry,
  documentPath,
  serializeDocEvent,
  validateCurrentDocEvent,
  validateDocEvent,
  type DocumentState,
} from "../../src/domain/doc-sync.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "../../src/domain/migration-import-event.ts";
import { validateWriteReceipt } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

import {
  actor,
  authorizeDocWrite,
  baseLedgerSha,
  claim,
  currentLedgerSha,
  decide,
  lease,
  opaqueClaim,
  state,
} from "./doc-sync.fixtures.ts";

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
      ...rejectedAcceptance,
      outcome: "op_rejected",
      opId: "doc-op",
      code: staleLedger.code,
      origin: "doc-sync-contract",
      evidence: `contract-rejection:${staleLedger.code}`,
      diagnostic: { kind: "failure", code: staleLedger.code },
      detail: staleLedger.detail,
      authorizationDecision: staleLedger.authorizationDecision!,
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

test("claim mismatch, deletion, machine touch, and ambiguous headings fail closed", () => {
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
  for (const candidate of ["---\nowner: other\n---\n# Notes\nA\n", "# Same\nA\n# Same\nB\n"]) {
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
    assert.equal(result.detail.unresolvedTouches[0]?.requiredRoute, "canonical-utf8-prose");
  }
});

test("prose regions may be removed, renamed, or reordered while file deletion and duplicate headings stay guarded", () => {
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
  assert.equal(missingResult.accepted, true, JSON.stringify(missingResult));
  const allMissing = "Replacement prose.\n",
    allMissingResult = decide({ ...prose, candidate: claim(allMissing) }, state(base), Buffer.from(allMissing));
  assert.equal(allMissingResult.accepted, true, JSON.stringify(allMissingResult));
  const reordered = "# Two\nB\n# One\nA\n",
    reorderedResult = decide({ ...prose, candidate: claim(reordered) }, state(base), Buffer.from(reordered));
  assert.equal(reorderedResult.accepted, true, JSON.stringify(reorderedResult));
});

test("prose policy accepts body replacement while freezing region proofs and content target", () => {
  const base = "# Notes\nOriginal sentence.\n",
    candidate = "# Notes\nReplacement sentence.\n",
    result = decide(
      {
        path: "context/notes.md",
        baseBlobSha256: sha256Text(base),
        policyId: DOC_POLICY_ID,
        candidate: claim(candidate),
      },
      state(base),
      Buffer.from(candidate),
    );
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(
    result.plan.targets.some((target) => target.kind === "content_blob" && target.sha256 === sha256Text(candidate)),
    true,
  );
  assert.equal(result.plan.targets.filter((target) => target.kind === "content_blob").length, 1);
});

test("body-replaceable policy accepts shorter prose and emits a valid canonical event", () => {
  assert.equal(DOC_POLICY_ID, "markdown-body-replaceable/v1");
  assert.equal(docRegionPolicyRegistry[0]?.writable, "body-replaceable");
  const base = "# Notes\nA much longer original sentence.\n",
    candidate = "# Notes\nShort.\n",
    result = decide(
      {
        path: "context/notes.md",
        baseBlobSha256: sha256Text(base),
        policyId: DOC_POLICY_ID,
        candidate: claim(candidate),
      },
      state(base),
      Buffer.from(candidate),
    );
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.doesNotThrow(() => serializeDocEvent(result.event));
});

test("new prose may establish frontmatter while existing machine frontmatter stays immutable", () => {
  const path = documentPath("context/frontmatter.md"),
    candidate = "---\ntitle: New document\n---\n# Notes\nBody\n";
  const created = decide(
    {
      path,
      baseBlobSha256: null,
      policyId: DOC_POLICY_ID,
      candidate: claim(candidate),
    },
    null,
    Buffer.from(candidate),
  );
  assert.equal(created.accepted, true, JSON.stringify(created));
  if (!created.accepted) return;
  const change = created.event.payload.changes[0]!;
  assert.equal(
    change.regionProofs.some((proof) => proof.regionId === "machine/frontmatter"),
    true,
  );

  const existingEmpty = { ...state(""), path };
  const introduced = decide(
    {
      path,
      baseBlobSha256: existingEmpty.blobSha256,
      policyId: DOC_POLICY_ID,
      candidate: claim(candidate),
    },
    existingEmpty,
    Buffer.from(candidate),
  );
  assert.equal(introduced.accepted, false);
  if (!introduced.accepted)
    assert.deepEqual(
      [introduced.code, introduced.detail.unresolvedTouches[0]?.reason],
      ["unresolved_touch", "new machine region is forbidden"],
    );

  const edited = candidate.replace("New document", "Changed document"),
    current = { ...state(candidate), path };
  const changed = decide(
    {
      path,
      baseBlobSha256: current.blobSha256,
      policyId: DOC_POLICY_ID,
      candidate: claim(edited),
    },
    current,
    Buffer.from(edited),
  );
  assert.equal(changed.accepted, false);
  if (!changed.accepted)
    assert.deepEqual(
      [changed.code, changed.detail.unresolvedTouches[0]?.reason],
      ["unresolved_touch", "machine region changed"],
    );
});

test("opaque textual policy is a whole-file CAS with no markdown parsing or region proofs", () => {
  const base = "---\nnot: frontmatter\n# Same\n# Same\nThis entire legacy payload is deliberately removed.\n",
    candidate = "<script/>\n",
    document: DocumentState = {
      ...state(base),
      path: documentPath("tasks/task-owner/artifacts/scripts/report.mjs"),
      mediaType: "text/javascript",
      policyId: OPAQUE_TEXTUAL_POLICY_ID,
    };
  const result = decide(
    {
      path: document.path,
      baseBlobSha256: sha256Text(base),
      policyId: OPAQUE_TEXTUAL_POLICY_ID,
      candidate: opaqueClaim(candidate, "text/javascript"),
    },
    document,
    Buffer.from(candidate),
  );
  assert.equal(result.accepted, true, JSON.stringify(result));
  if (!result.accepted) return;
  const change = result.event.payload.changes[0]!;
  assert.deepEqual(change.regionProofs, []);
  assert.deepEqual(validateDocEvent(JSON.parse(JSON.stringify(result.event))), []);
  assert.deepEqual(
    validateDocEvent({
      ...result.event,
      payload: {
        ...result.event.payload,
        changes: [
          {
            ...change,
            regionProofs: [
              {
                regionId: "prose/*",
                policyId: DOC_POLICY_ID,
                codecId: "markdown-regions/v1",
                baseSha256: sha256Text(base),
                candidateSha256: sha256Text(candidate),
                insertBytes: 0,
              },
            ],
          },
        ],
      },
    }),
    ["doc event change is invalid"],
  );
  assert.deepEqual(
    validateDocEvent({
      ...result.event,
      payload: {
        ...result.event.payload,
        changes: [
          {
            ...change,
            policyId: DOC_POLICY_ID,
            regionProofs: [
              {
                regionId: "prose/*",
                policyId: DOC_POLICY_ID,
                codecId: "markdown-regions/v1",
                baseSha256: sha256Text(base),
                candidateSha256: sha256Text(candidate),
                insertBytes: 0,
              },
            ],
          },
        ],
      },
    }),
    ["doc event change is invalid"],
  );
});

test("task path fallback derives the owning task from both real id shapes in slug folders", () => {
  const body = "report\n";
  const write = (taskId: string, folder: string) =>
    decide(
      {
        path: documentPath(`tasks/${folder}/artifacts/report.md`),
        baseBlobSha256: null,
        policyId: OPAQUE_TEXTUAL_POLICY_ID,
        candidate: opaqueClaim(body),
      },
      null,
      Buffer.from(body),
      { lease: { ...lease, taskId } },
    );

  const hexId = "task_f7cc215a54a194898ad733c20a";
  const ulidId = "task_01KWVTPX3AH5TG8VK4RJYXE7EZ";

  const hexWrite = write(hexId, `${hexId}-allowlist-hex-ref`);
  assert.equal(hexWrite.accepted, true, JSON.stringify(hexWrite));

  const ulidWrite = write(ulidId, `${ulidId}-legacy-ulid`);
  assert.equal(ulidWrite.accepted, true, JSON.stringify(ulidWrite));

  const mismatch = write(hexId, `${ulidId}-legacy-ulid`);
  assert.equal(mismatch.accepted, false);
  if (!mismatch.accepted) assert.equal(mismatch.code, "unresolved_touch");
});

test("the first authored write on a migrated document upgrades its policy one-way with from/to recorded", () => {
  const base = "# Notes\nA\n",
    next = `${base}B\n`,
    migrated = (body: string): DocumentState => ({
      ...state(body),
      policyId: MIGRATION_DOCUMENT_POLICY_ID,
    });
  const run = (policyId: string, current: DocumentState | null, candidate: string) =>
    decide(
      {
        path: "context/notes.md",
        baseBlobSha256: current?.blobSha256 ?? null,
        policyId,
        candidate: claim(candidate),
      },
      current,
      Buffer.from(candidate),
    );
  const upgraded = run(DOC_POLICY_ID, migrated(base), next);
  assert.equal(upgraded.accepted, true, JSON.stringify(upgraded));
  if (!upgraded.accepted) return;
  const change = upgraded.event.payload.changes[0]!;
  assert.equal(change.policyId, DOC_POLICY_ID);
  assert.deepEqual(change.policyUpgrade, {
    from: MIGRATION_DOCUMENT_POLICY_ID,
    to: DOC_POLICY_ID,
  });
  const restamped = run(DOC_POLICY_ID, { ...state(base), policyId: OPAQUE_TEXTUAL_POLICY_ID }, next);
  assert.equal(restamped.accepted, true, JSON.stringify(restamped));
  if (restamped.accepted)
    assert.deepEqual(restamped.event.payload.changes[0]?.policyUpgrade, {
      from: OPAQUE_TEXTUAL_POLICY_ID,
      to: DOC_POLICY_ID,
    });
  const artifactPath = "tasks/task-owner/artifacts/report.md",
    blockedArtifactRestamp = decide(
      {
        path: artifactPath,
        baseBlobSha256: sha256Text(base),
        policyId: DOC_POLICY_ID,
        candidate: claim(next),
      },
      { ...state(base), path: artifactPath, policyId: OPAQUE_TEXTUAL_POLICY_ID },
      Buffer.from(next),
    );
  assert.equal(blockedArtifactRestamp.accepted, false);
  if (!blockedArtifactRestamp.accepted) assert.equal(blockedArtifactRestamp.code, "semantic_policy_changed");
  assert.doesNotThrow(() => serializeDocEvent(upgraded.event));
  assert.deepEqual(validateDocEvent(JSON.parse(JSON.stringify(upgraded.event))), []);
  assert.deepEqual(
    validateDocEvent({
      ...upgraded.event,
      payload: {
        ...upgraded.event.payload,
        changes: [
          {
            ...change,
            policyUpgrade: {
              from: DOC_POLICY_ID,
              to: MIGRATION_DOCUMENT_POLICY_ID,
            },
          },
        ],
      },
    }),
    ["doc event change is invalid"],
  );
  for (const [name, rejected] of [
    ["migrated-shell write", run(MIGRATION_DOCUMENT_POLICY_ID, migrated(base), next)],
    ["downgrade after upgrade", run(MIGRATION_DOCUMENT_POLICY_ID, state(next), `${next}C\n`)],
  ] as const) {
    assert.equal(rejected.accepted, false, name);
    if (!rejected.accepted) assert.equal(rejected.code, "semantic_policy_changed", name);
  }
  const native = run(DOC_POLICY_ID, { ...state(next), workspaceRevision: 3 }, `${next}C\n`);
  assert.equal(native.accepted, true, JSON.stringify(native));
  if (native.accepted) assert.equal("policyUpgrade" in native.event.payload.changes[0]!, false);
});

test("an upgraded write still allows authored prose heading reordering", () => {
  const base = "# One\nA\n# Two\nB\n",
    reordered = "# Two\nB\n# One\nA\n",
    result = decide(
      {
        path: "context/notes.md",
        baseBlobSha256: sha256Text(base),
        policyId: DOC_POLICY_ID,
        candidate: claim(reordered),
      },
      { ...state(base), policyId: MIGRATION_DOCUMENT_POLICY_ID },
      Buffer.from(reordered),
    );
  assert.equal(result.accepted, true, JSON.stringify(result));
});

test("receipt detail registry rejects unregistered or open-ended detail shapes", () => {
  const body = "# Notes\nA\n",
    rejected = decide(
      {
        path: "context/notes.md",
        baseBlobSha256: sha256Text(body),
        policyId: DOC_POLICY_ID,
        candidate: null,
      },
      state(body),
      null,
    );
  if (rejected.accepted) assert.fail("expected rejection");
  const receipt = {
    ...rejectedAcceptance,
    outcome: "op_rejected",
    opId: "doc-op",
    code: rejected.code,
    origin: "doc-sync-contract",
    evidence: `contract-rejection:${rejected.code}`,
    diagnostic: { kind: "failure", code: rejected.code },
    detail: rejected.detail,
    authorizationDecision: authorizeDocWrite(),
  };
  assert.deepEqual(validateWriteReceipt(receipt), []);
  assert.match(
    validateWriteReceipt({
      ...receipt,
      detail: { ...rejected.detail, legacy: true },
    }).join("\n"),
    /registered receipt domain/u,
  );
});
