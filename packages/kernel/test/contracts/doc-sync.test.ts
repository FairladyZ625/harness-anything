// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  OPAQUE_TEXTUAL_MEDIA_TYPE,
  OPAQUE_TEXTUAL_POLICY_ID,
  classifyTextualArtifactPath,
} from "../../src/domain/artifact-text-classification.ts";
import docSyncContract, {
  DOC_POLICY_ID,
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
} from "../../src/domain/doc-sync.contract.ts";
import { validateWriteReceipt, validateWriteSource } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { validateCanonicalWriteBundle } from "../../src/store/task-event-store.ts";

import {
  baseLedgerSha,
  claim,
  currentLedgerSha,
  decide,
  legacyDocEventBytes,
  opaqueClaim,
  state,
} from "./doc-sync.fixtures.ts";
test("derived doc-sync contract closes intent and event schemas", () => {
  assert.deepEqual(
    docSyncContract.schemas.map((schema) => schema.id),
    ["doc-write-intent/v1", "doc-event/v1", "people-event/v1"],
  );
  assert.equal(
    docSyncContract.schemas.every((schema) => schema.negativeFixtures.length > 0),
    true,
  );
  const parsed = parseDocWriteIntent(
    {
      schema: "doc-write-intent/v1",
      executionId: "execution-1",
      baseLedgerSha,
      changes: [
        {
          path: "context/notes.md",
          baseBlobSha256: null,
          policyId: DOC_POLICY_ID,
          candidate: claim("body\n"),
        },
      ],
    },
    "docs",
  );
  assert.deepEqual(JSON.parse(serializeDocWriteIntent(parsed)).baseLedgerSha, baseLedgerSha);
  const historicalWatcherSource = {
    kind: "watch_session",
    sessionId: "watch-one",
    path: "context/notes.md",
    fingerprint: "a".repeat(64),
  };
  assert.deepEqual(validateWriteSource(historicalWatcherSource, true), []);
  assert.match(validateWriteSource(historicalWatcherSource).join("\n"), /assignment identity/u);
});

test("canonical reader accepts the historical doc-event ledger identity bytes", () => {
  const parsed = parseCanonicalEvent(legacyDocEventBytes);
  assert.equal(parsed.schema, "doc-event/v1");
  assert.equal(parsed.workspaceRevision, 21402);
  assert.deepEqual(parsed.payload.baseLedgerSha, {
    repoId: "harness-anything",
    sha: "de2fe7239e570c7c9ed6fe8417a32f008bbf7ccc",
  });
  assert.equal(serializeCanonicalEvent(parsed), legacyDocEventBytes);
  assert.deepEqual(
    validateWriteReceipt({
      outcome: "applied",
      opId: parsed.opId,
      revision: parsed.workspaceRevision,
      evidence: `event-object:${parsed.opId}`,
      visibility: "center",
      proof: {
        committedRevision: parsed.workspaceRevision,
        appliedCut: parsed.workspaceRevision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: null,
      },
      detail: {
        kind: "doc_sync",
        code: "applied",
        baseLedgerSha: parsed.payload.baseLedgerSha,
        currentLedgerSha,
        paths: [],
        holder: null,
        differences: [],
        unresolvedTouches: [],
        deletions: [],
        nextAction: "no action required",
      },
    }),
    [],
  );
});

test("canonical writer rejects the historical doc-event ledger identity", () => {
  const body = "# Notes\nReplacement sentence.\n",
    result = decide(
      {
        path: "context/notes.md",
        baseBlobSha256: sha256Text("# Notes\nOriginal sentence.\n"),
        policyId: DOC_POLICY_ID,
        candidate: claim(body),
      },
      state("# Notes\nOriginal sentence.\n"),
      Buffer.from(body),
    );
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const legacy = {
    ...result.event,
    payload: {
      ...result.event.payload,
      baseLedgerSha: { repoId: "docs", sha: "0".repeat(40) },
    },
  };
  assert.deepEqual(validateDocEvent(legacy), []);
  assert.match(validateCurrentDocEvent(legacy).join("\n"), /invalid/u);
  assert.throws(() => serializeDocEvent(legacy), /invalid/u);
  assert.throws(
    () =>
      validateCanonicalWriteBundle({
        event: legacy,
        plan: docSyncWritePlan(legacy),
        blobs: result.blobs,
      }),
    /current cut/u,
  );
});

test("doc ingress rejects non-portable paths and same-batch Unicode collisions", () => {
  const change = {
    path: "context/CON.md",
    baseBlobSha256: null,
    policyId: DOC_POLICY_ID,
    candidate: claim("body\n"),
  };
  assert.match(
    validateDocWriteIntent({
      schema: "doc-write-intent/v1",
      executionId: "execution-1",
      baseLedgerSha,
      changes: [change],
    }).join("\n"),
    /portable|reserved/iu,
  );
  const collision = {
    schema: "doc-write-intent/v1",
    executionId: "execution-1",
    baseLedgerSha,
    changes: [
      { ...change, path: "context/café.md" },
      { ...change, path: "context/cafe\u0301.md" },
    ],
  };
  assert.match(validateDocWriteIntent(collision).join("\n"), /collision/iu);
  assert.match(
    validateDocWriteIntent({
      ...collision,
      changes: [
        {
          ...change,
          path: "context/ok.md",
          candidate: {
            ...change.candidate!,
            size: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      ],
    }).join("\n"),
    /claim/iu,
  );
  assert.match(
    validateDocWriteIntent({
      ...collision,
      changes: [
        {
          ...change,
          path: "context/ok.md",
          candidate: { ...change.candidate!, ref: "doc-sync-claims/CON" },
        },
      ],
    }).join("\n"),
    /claim/iu,
  );
});

test("default prose route is open while typed internal routes are denied", () => {
  assert.deepEqual(resolveDocRoute(documentPath("context/new-area/notes.md")), {
    allowed: true,
    requiredRoute: "doc-sync",
  });
  assert.deepEqual(resolveDocRoute(documentPath("events/op.json")), {
    allowed: false,
    requiredRoute: "canonical-event",
  });
  assert.deepEqual(resolveDocRoute(documentPath("people.yaml")), {
    allowed: false,
    requiredRoute: "people-registry",
  });
  assert.throws(() => documentPath("../outside.md"));
});

test("textual artifacts are opaque by location while preserving their media type", () => {
  for (const [target, mediaType] of [
    ["artifacts/summary.md", "text/markdown"],
    ["artifacts/notes.txt", "text/plain"],
    ["artifacts/report.html", "text/html"],
    ["artifacts/report.htm", "text/html"],
    ["artifacts/scripts/build.mjs", "text/javascript"],
    ["artifacts/scripts/build.js", "text/javascript"],
    ["artifacts/data.json", "application/json"],
    ["artifacts/styles/main.css", "text/css"],
    ["artifacts/data.yaml", "application/yaml"],
    ["artifacts/data.yml", "application/yaml"],
    ["artifacts/data.csv", "text/csv"],
    ["artifacts/unknown.foo", OPAQUE_TEXTUAL_MEDIA_TYPE],
    ["artifacts/NOTICE", OPAQUE_TEXTUAL_MEDIA_TYPE],
    ["artifacts/.metadata", OPAQUE_TEXTUAL_MEDIA_TYPE],
  ] as const)
    assert.deepEqual(
      classifyTextualArtifactPath(target),
      { kind: "opaque-textual", mediaType, policyId: OPAQUE_TEXTUAL_POLICY_ID },
      target,
    );
  assert.deepEqual(classifyTextualArtifactPath("context/report.md"), {
    kind: "canonical-prose",
    mediaType: "text/markdown",
    policyId: DOC_POLICY_ID,
  });
  assert.deepEqual(classifyTextualArtifactPath("context/notes.txt"), {
    kind: "canonical-prose",
    mediaType: "text/plain",
    policyId: DOC_POLICY_ID,
  });
  assert.equal(classifyTextualArtifactPath("context/report.html"), null);
});

test("doc content claims accept only the supported opaque textual media types", () => {
  const base = {
    schema: "doc-write-intent/v1",
    executionId: "execution-1",
    baseLedgerSha,
    changes: [
      {
        path: "tasks/task-owner/artifacts/report.json",
        baseBlobSha256: null,
        policyId: OPAQUE_TEXTUAL_POLICY_ID,
        candidate: opaqueClaim("{}\n", "application/json"),
      },
    ],
  };
  for (const mediaType of ["application/json", "text/markdown", "text/plain"] as const)
    assert.deepEqual(
      validateDocWriteIntent({
        ...base,
        changes: [
          {
            ...base.changes[0]!,
            candidate: { ...base.changes[0]!.candidate, mediaType },
          },
        ],
      }),
      [],
      mediaType,
    );
  assert.match(
    validateDocWriteIntent({
      ...base,
      changes: [
        {
          ...base.changes[0]!,
          candidate: {
            ...base.changes[0]!.candidate,
            mediaType: "application/octet-stream",
          },
        },
      ],
    }).join("\n"),
    /claim/iu,
  );
});
