// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyTextualArtifactPath,
  OPAQUE_TEXTUAL_MEDIA_TYPE,
  OPAQUE_TEXTUAL_POLICY_ID,
} from "../../src/domain/artifact-text-classification.ts";
import docSyncContract, {
  DOC_POLICY_ID,
  decideDocWrite,
  docRegionPolicyRegistry,
  docSyncWritePlan,
  documentPath,
  parseCanonicalEvent,
  parseDocWriteIntent,
  resolveDocRoute,
  serializeCanonicalEvent,
  serializeDocEvent,
  serializeDocWriteIntent,
  validateCurrentDocEvent,
  validateDocEvent,
  validateDocWriteIntent,
  verifyDocEventChange,
  type ContentClaim,
  type DocWriteChange,
  type DocumentState,
} from "../../src/domain/doc-sync.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "../../src/domain/migration-import-event.ts";
import { resolveLiveTaskBoundRuntimeBinding } from "../../src/domain/task-bound-runtime-authority.ts";
import {
  validateWriteReceipt,
  validateWriteSource,
} from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { validateCanonicalWriteBundle } from "../../src/store/task-event-store.ts";

import {
  actor,
  baseLedgerSha,
  claim,
  currentLedgerSha,
  decide,
  lease,
  legacyDocEventBytes,
  opaqueClaim,
  state,
} from "./doc-sync.fixtures.ts";
test("the first authored write on a migrated document upgrades its policy one-way with from/to recorded", () => {
  const base = "# Notes\nA\n",
    next = `${base}B\n`,
    migrated = (body: string): DocumentState => ({
      ...state(body),
      policyId: MIGRATION_DOCUMENT_POLICY_ID,
    });
  const run = (
    policyId: string,
    current: DocumentState | null,
    candidate: string,
  ) =>
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
  assert.doesNotThrow(() => serializeDocEvent(upgraded.event));
  assert.deepEqual(
    validateDocEvent(JSON.parse(JSON.stringify(upgraded.event))),
    [],
  );
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
    [
      "migrated-shell write",
      run(MIGRATION_DOCUMENT_POLICY_ID, migrated(base), next),
    ],
    [
      "downgrade after upgrade",
      run(MIGRATION_DOCUMENT_POLICY_ID, state(next), `${next}C\n`),
    ],
  ] as const) {
    assert.equal(rejected.accepted, false, name);
    if (!rejected.accepted)
      assert.equal(rejected.code, "semantic_policy_changed", name);
  }
  const native = run(
    DOC_POLICY_ID,
    { ...state(next), workspaceRevision: 3 },
    `${next}C\n`,
  );
  assert.equal(native.accepted, true, JSON.stringify(native));
  if (native.accepted)
    assert.equal("policyUpgrade" in native.event.payload.changes[0]!, false);
});

test("an upgraded write still runs the full region differ and heading preservation", () => {
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
  assert.equal(result.accepted, false, JSON.stringify(result));
  if (!result.accepted) {
    assert.equal(result.code, "unresolved_touch");
    assert.equal(
      result.detail.unresolvedTouches.some(
        ({ reason }) =>
          reason ===
          'base regions are reordered: candidate places "# Two" before "# One"; expected "# One" before "# Two"',
      ),
      true,
    );
  }
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
    outcome: "op_rejected",
    opId: "doc-op",
    code: rejected.code,
    origin: "doc-sync-contract",
    evidence: `contract-rejection:${rejected.code}`,
    nextAction: rejected.detail.nextAction,
    detail: rejected.detail,
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
