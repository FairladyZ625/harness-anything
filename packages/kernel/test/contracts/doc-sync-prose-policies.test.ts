// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import {
  DOC_POLICY_ID,
  docRegionPolicyRegistry,
  documentPath,
  serializeDocEvent,
  validateDocEvent,
  verifyDocEventChange,
  type DocumentState,
} from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";

import { claim, decide, opaqueClaim, state } from "./doc-sync.fixtures.ts";
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
    result.plan.targets.some(
      (target) =>
        target.kind === "content_blob" &&
        target.sha256 === sha256Text(candidate),
    ),
    true,
  );
  assert.equal(
    result.plan.targets.filter((target) => target.kind === "content_blob")
      .length,
    1,
  );
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
    change.regionProofs.some(
      (proof) => proof.regionId === "machine/frontmatter",
    ),
    true,
  );
  assert.equal(verifyDocEventChange(change, "", candidate), true);

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
  const base =
      "---\nnot: frontmatter\n# Same\n# Same\nThis entire legacy payload is deliberately removed.\n",
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
  assert.deepEqual(
    validateDocEvent(JSON.parse(JSON.stringify(result.event))),
    [],
  );
  assert.equal(verifyDocEventChange(change, base, candidate), true);
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
