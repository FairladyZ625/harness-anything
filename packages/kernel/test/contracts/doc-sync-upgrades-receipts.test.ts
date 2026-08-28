// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import {
  DOC_POLICY_ID,
  serializeDocEvent,
  validateDocEvent,
  type DocumentState,
} from "../../src/domain/doc-sync.contract.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "../../src/domain/migration-import-event.ts";
import { validateWriteReceipt } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

import { claim, decide, state } from "./doc-sync.fixtures.ts";
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
