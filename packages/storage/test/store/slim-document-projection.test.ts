// harness-test-tier: fast
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import { compileDecisionWrite, decisionWritePlan } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docByteLength,
  docSyncWritePlan,
  type DocEventV1,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { compileFactWrite, factWritePlan } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { sha256Bytes, sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { localContentObjectFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import {
  makeTaskProjection,
  makeTaskProjectionReader,
  ProjectionContentBlobError,
} from "../../src/projection/rebuildable-task-projection.ts";
import { objectPath } from "../../src/store/content-objects.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-ledger-layout.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { proposal } from "./relation-graph-projection.fixtures.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

function casObjectPath(rootDir: string, sha256: string): string {
  return objectPath(path.join(path.dirname(sqliteLedgerPath(rootDir, 3)), "objects", "sha256"), sha256);
}

function makeTextDocBundle(input: {
  readonly revision: number;
  readonly path: string;
  readonly body: string;
  readonly baseSha: string | null;
  readonly baseLedgerSha: DocEventV1["payload"]["baseLedgerSha"];
  readonly mediaType?: "text/markdown" | "text/plain" | "text/html";
  readonly policyId?: string;
  readonly occurredAt: string;
}) {
  const bytes = Buffer.from(input.body, "utf8");
  const sha256 = sha256Bytes(bytes);
  const mediaType = input.mediaType ?? "text/markdown";
  const policyId = input.policyId ?? DOC_POLICY_ID;
  const event: DocEventV1 = {
    schema: "doc-event/v1",
    eventId: `ev-doc-${input.revision}`,
    workspaceRevision: input.revision,
    opId: `op-doc-${input.revision}`,
    type: "documents_written",
    actor: { principal: { personId: "person-s3" }, executor: null },
    source: "local",
    occurredAt: input.occurredAt,
    payload: {
      executionId: null,
      baseLedgerSha: input.baseLedgerSha,
      changes: [
        {
          path: input.path as DocEventV1["payload"]["changes"][number]["path"],
          baseBlobSha256: input.baseSha,
          policyId,
          candidate: {
            sha256,
            size: docByteLength(bytes.byteLength),
            mediaType,
          },
          regionProofs:
            policyId === DOC_POLICY_ID
              ? [
                  {
                    regionId: "prose/body",
                    policyId: DOC_POLICY_ID,
                    codecId: DOC_CODEC_ID,
                    baseSha256: input.baseSha ?? sha256Text(""),
                    candidateSha256: sha256,
                    insertBytes: bytes.byteLength,
                  },
                ]
              : [],
        },
      ],
    },
  };
  return {
    event,
    plan: docSyncWritePlan(event),
    blobs: [{ sha256, size: bytes.byteLength, mediaType, body: input.body }],
    sha256,
  };
}

function makeRawArtifactBundle(input: {
  readonly revision: number;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly baseLedgerSha: DocEventV1["payload"]["baseLedgerSha"];
  readonly occurredAt: string;
}) {
  const sha256 = sha256Bytes(input.bytes);
  const mediaType = "application/octet-stream" as unknown as "text/plain";
  const event: DocEventV1 = {
    schema: "doc-event/v1",
    eventId: `ev-raw-${input.revision}`,
    workspaceRevision: input.revision,
    opId: `op-raw-${input.revision}`,
    type: "documents_written",
    actor: { principal: { personId: "person-s3" }, executor: null },
    source: "local",
    occurredAt: input.occurredAt,
    payload: {
      executionId: null,
      baseLedgerSha: input.baseLedgerSha,
      changes: [
        {
          path: input.path as DocEventV1["payload"]["changes"][number]["path"],
          baseBlobSha256: null,
          policyId: RAW_ARTIFACT_POLICY_ID,
          candidate: {
            sha256,
            size: docByteLength(input.bytes.byteLength),
            mediaType,
          },
          regionProofs: [],
        },
      ],
    },
  };
  return {
    event,
    plan: docSyncWritePlan(event),
    blobs: [{ sha256, size: input.bytes.byteLength, mediaType: "application/octet-stream", body: input.bytes }],
    sha256,
  };
}

function seedSlimProjectionLedger(rootDir: string, repoId: string) {
  initRepo(rootDir);
  const eventStore = makeTaskEventStore({ repoId, rootDir });
  let rev = 0;
  const nextRev = () => ++rev;
  const at = (n: number) => `2026-11-28T03:${String(n).padStart(2, "0")}:00.000Z`;
  const bundles: Array<{
    readonly event: PersistedCanonicalEventV1;
    readonly plan:
      | ReturnType<typeof docSyncWritePlan>
      | ReturnType<typeof factWritePlan>
      | ReturnType<typeof decisionWritePlan>;
  }> = [];

  const append = (bundle: {
    readonly event: PersistedCanonicalEventV1;
    readonly plan:
      | ReturnType<typeof docSyncWritePlan>
      | ReturnType<typeof factWritePlan>
      | ReturnType<typeof decisionWritePlan>;
    readonly blobs: readonly {
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
      readonly body: string | Uint8Array;
    }[];
  }) => {
    eventStore.append(bundle as Parameters<typeof eventStore.append>[0]);
    bundles.push({ event: bundle.event, plan: bundle.plan });
  };

  // 1. Non-interpreted markdown artifact under tasks/*/artifacts/*
  const artifactPath = "tasks/task_slim-demo/artifacts/report.md";
  const artifactBody = `# Artifact Report\n\n${'Line payload with Unicode 雪 and quotes "ok".\n'.repeat(256)}`;
  const artifactBundle = makeTextDocBundle({
    revision: nextRev(),
    path: artifactPath,
    body: artifactBody,
    baseSha: null,
    baseLedgerSha: eventStore.currentCut(),
    mediaType: "text/markdown",
    policyId: OPAQUE_TEXTUAL_POLICY_ID,
    occurredAt: at(1),
  });
  append(artifactBundle);

  // 2. Raw binary artifact (non-UTF-8 bytes) under tasks/*/artifacts/*
  const rawPath = "tasks/task_slim-demo/artifacts/payload.bin";
  const rawBytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xde, 0xad, 0xbe, 0xef, 0x42]);
  const rawBundle = makeRawArtifactBundle({
    revision: nextRev(),
    path: rawPath,
    bytes: rawBytes,
    baseLedgerSha: eventStore.currentCut(),
    occurredAt: at(2),
  });
  append(rawBundle);

  // 3. Active fact + archived fact (populates both document and document_history)
  const activeFactRev = nextRev();
  const activeFact = compileFactWrite({
    event: {
      schema: "fact-event/v1",
      eventId: `ev-fact-${activeFactRev}`,
      workspaceRevision: activeFactRev,
      opId: `op-fact-${activeFactRev}`,
      factId: "F-AAAABBBB",
      type: "fact_recorded",
      actor: { principal: { personId: "person-s3" }, executor: null },
      source: "local",
      occurredAt: at(3),
      payload: {
        statement: "Active fact body stays readable via CAS.",
        evidenceSource: "packages/storage/src/projection/document-projection-content.ts:1",
        observedAt: at(3),
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "sess-s3",
            transcriptReachability: "by_session_id",
            boundAt: at(3),
          },
        ],
      },
    },
  });
  append({ ...activeFact, plan: factWritePlan(activeFact.event) });

  const archivedFactRev = nextRev();
  const archivedFact = compileFactWrite({
    event: {
      schema: "fact-event/v1",
      eventId: `ev-fact-${archivedFactRev}`,
      workspaceRevision: archivedFactRev,
      opId: `op-fact-${archivedFactRev}`,
      factId: "F-CCCCDDDD",
      type: "fact_recorded",
      actor: { principal: { personId: "person-s3" }, executor: null },
      source: "local",
      occurredAt: at(4),
      payload: {
        statement: "Archived fact body moves to document_history and hydrates from CAS.",
        evidenceSource: "packages/storage/src/projection/rebuildable-task-projection-reads.ts:1",
        observedAt: at(4),
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "sess-s3",
            transcriptReachability: "by_session_id",
            boundAt: at(4),
          },
        ],
      },
    },
  });
  append({ ...archivedFact, plan: factWritePlan(archivedFact.event) });

  const factArchiveRev = nextRev();
  const { factsDocumentClaim: _droppedClaim, ...archivedFactPayload } = archivedFact.event.payload;
  const factArchiveEvent: PersistedCanonicalEventV1 = {
    ...archivedFact.event,
    eventId: `ev-fact-arch-${factArchiveRev}`,
    workspaceRevision: factArchiveRev,
    opId: `op-fact-arch-${factArchiveRev}`,
    type: "fact_archived",
    occurredAt: at(5),
    payload: {
      ...archivedFactPayload,
      archiveReason: "exercise document_history hydration",
      factsDocumentRetirement: {
        path: "facts/F-CCCCDDDD.md",
        sha256: archivedFact.event.payload.factsDocumentClaim!.sha256,
      },
    },
  };
  append({ event: factArchiveEvent, plan: factWritePlan(factArchiveEvent), blobs: [] });

  // 4. Interpreted Decision (active)
  const decisionRev = nextRev();
  const decisionId = "dec_SLIM_ACTIVE_01";
  const rawDecisionProposal = proposal(decisionRev, decisionId);
  assert.equal(rawDecisionProposal.type, "decision_proposed");
  const decisionCompiled = compileDecisionWrite({
    decisionReviewRequirement: "off",
    event: {
      ...rawDecisionProposal,
      occurredAt: at(6),
      payload: {
        ...rawDecisionProposal.payload,
        body: "# Slim Projection Decision\n\nVerify on-demand CAS hydration for Decision bodies and FTS.\n",
        provenance: [
          {
            runtime: "codex",
            sessionId: "sess-s3-decision",
            transcriptReachability: "by_session_id",
            boundAt: at(6),
          },
        ],
      },
    },
    currentDecision: null,
    currentRelations: [],
    currentDocument: null,
  });
  append({ ...decisionCompiled, plan: decisionWritePlan(decisionCompiled.event) });

  return {
    eventStore,
    bundles,
    artifactPath,
    artifactBody,
    artifactSha: artifactBundle.sha256,
    rawPath,
    rawBytes,
    rawSha: rawBundle.sha256,
    activeFactPath: "facts/F-AAAABBBB.md",
    activeFactBody: activeFact.blobs[0]!.body as string,
    activeFactSha: activeFact.event.payload.factsDocumentClaim!.sha256,
    archivedFactPath: "facts/F-CCCCDDDD.md",
    archivedFactBody: archivedFact.blobs[0]!.body as string,
    archivedFactSha: archivedFact.event.payload.factsDocumentClaim!.sha256,
    decisionId,
    decisionPath: `decisions/decision-${decisionId}/decision.md`,
    decisionBody: decisionCompiled.body,
    decisionSha: decisionCompiled.event.payload.decisionDocumentClaim.sha256,
  };
}

function assertNoInlineDocumentBodies(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const table of ["document", "document_history"] as const) {
      const withBody = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE json_type(value_json, '$.body') IS NOT NULL`)
        .get() as { readonly count: number };
      assert.equal(Number(withBody.count), 0, `${table} must not store inline body in schema v40`);
    }
  } finally {
    db.close();
  }
}

test("schema v39->v40 upgrades in place without full replay and produces byte-identical stateDigest with incremental and cold rebuild", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const seeded = seedSlimProjectionLedger(rootDir, "s3-v39-upgrade-parity");
    t.after(() => seeded.eventStore.drain());

    // (a) Incremental steady-state apply
    const incrementalPath = path.join(rootDir, ".harness", "cache", "incremental.sqlite");
    const incremental = makeTaskProjection({ rootDir, projectionPath: incrementalPath, eventStore: seeded.eventStore });
    for (const { event, plan } of seeded.bundles) {
      incremental.apply(event, plan);
    }
    const incrementalDigest = incremental.readStateDigest();
    assert.ok(incrementalDigest !== null);
    assertNoInlineDocumentBodies(incrementalPath);
    incremental.close();

    // (b) Seed an authentic v39 cache with inline `body` in both `document` and `document_history`
    const upgradedPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
    const v39Seed = makeTaskProjection({ rootDir, projectionPath: upgradedPath, eventStore: seeded.eventStore });
    for (const { event, plan } of seeded.bundles) {
      v39Seed.apply(event, plan);
    }
    v39Seed.close();

    const rawDb = new DatabaseSync(upgradedPath);
    try {
      const injectBodies = (table: "document" | "document_history") => {
        const rows = rawDb.prepare(`SELECT path, value_json FROM ${table}`).all() as readonly {
          readonly path: string;
          readonly value_json: string;
        }[];
        assert.ok(rows.length > 0, `${table} must have rows to test v39->v40 upgrade`);
        const update = rawDb.prepare(`UPDATE ${table} SET value_json = ? WHERE path = ?`);
        for (const row of rows) {
          const parsed = JSON.parse(row.value_json) as {
            readonly blobSha256: string;
            readonly policyId: string;
          };
          const body =
            parsed.policyId === RAW_ARTIFACT_POLICY_ID
              ? ""
              : Buffer.from(seeded.eventStore.readContentBlob(parsed.blobSha256)!).toString("utf8");
          update.run(JSON.stringify({ ...parsed, body }), row.path);
        }
      };
      rawDb.exec("BEGIN");
      injectBodies("document");
      injectBodies("document_history");
      rawDb.prepare("UPDATE projection_meta SET schema_version = 39 WHERE singleton = 1").run();
      rawDb.exec("COMMIT");

      assert.equal(
        Number(
          (
            rawDb
              .prepare("SELECT COUNT(*) AS count FROM document WHERE json_type(value_json, '$.body') IS NOT NULL")
              .get() as {
              readonly count: number;
            }
          ).count,
        ) > 0,
        true,
      );
      assert.equal(
        Number(
          (
            rawDb
              .prepare(
                "SELECT COUNT(*) AS count FROM document_history WHERE json_type(value_json, '$.body') IS NOT NULL",
              )
              .get() as { readonly count: number }
          ).count,
        ) > 0,
        true,
      );
    } finally {
      rawDb.close();
    }

    // Reopen v39 DB under v40: MUST upgrade in-place (0 discards, monotonic validation progress).
    const progressEvents: Array<{ readonly applied: number; readonly total: number }> = [];
    const logged = t.mock.method(console, "error", () => undefined);
    const upgraded = makeTaskProjection({
      rootDir,
      projectionPath: upgradedPath,
      eventStore: seeded.eventStore,
      onValidationProgress: (progress) => progressEvents.push(progress),
    });
    try {
      assert.equal(logged.mock.callCount(), 0, "v39->v40 in-place upgrade must not discard/replay the cache");
      assert.ok(progressEvents.length > 0, "v39->v40 in-place upgrade reports validation progress");
      assert.equal(progressEvents.at(-1)!.applied, progressEvents.at(-1)!.total);

      assertNoInlineDocumentBodies(upgradedPath);
      const inspectDb = new DatabaseSync(upgradedPath, { readOnly: true });
      try {
        const meta = inspectDb.prepare("SELECT schema_version FROM projection_meta WHERE singleton = 1").get() as {
          readonly schema_version: number;
        };
        assert.equal(Number(meta.schema_version), taskProjectionSchemaVersion);
        assert.equal(taskProjectionSchemaVersion, 41);
        const trigger = inspectDb
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='document_artifact_update'")
          .get();
        assert.ok(trigger, "document_artifact_update trigger must be restored after v39->v40 upgrade");
      } finally {
        inspectDb.close();
      }

      // Verify exact CAS hydration on both writer projection and query-only reader
      assert.equal(upgraded.readDocument(seeded.artifactPath).document?.body, seeded.artifactBody);
      assert.equal(upgraded.readDocument(seeded.rawPath).document?.body, "");
      assert.equal(upgraded.readDocument(seeded.rawPath).document?.blobSha256, seeded.rawSha);
      assert.equal(upgraded.readDocument(seeded.activeFactPath).document?.body, seeded.activeFactBody);
      assert.equal(upgraded.readDocumentHistory(seeded.archivedFactPath).document?.body, seeded.archivedFactBody);
      const expectedDecisionProse =
        "# Slim Projection Decision\n\nVerify on-demand CAS hydration for Decision bodies and FTS.\n";
      assert.equal(upgraded.readDecision(seeded.decisionId, true).decision?.body?.body, expectedDecisionProse);

      const reader = makeTaskProjectionReader({ rootDir, projectionPath: upgradedPath });
      try {
        reader.withSession((queries) => {
          assert.equal(queries.readDocument(seeded.artifactPath).document?.body, seeded.artifactBody);
          assert.equal(queries.readDocumentHistory(seeded.archivedFactPath).document?.body, seeded.archivedFactBody);
          assert.equal(queries.readDecision(seeded.decisionId, true).decision?.body?.body, expectedDecisionProse);
        });
      } finally {
        reader.close();
      }

      const upgradedDigest = upgraded.readStateDigest();
      assert.equal(upgradedDigest, incrementalDigest, "v39->v40 in-place upgrade must match incremental stateDigest");

      // (c) Cold rebuild from zero
      const coldPath = path.join(rootDir, ".harness", "cache", "cold.sqlite");
      const cold = makeTaskProjection({ rootDir, projectionPath: coldPath, eventStore: seeded.eventStore });
      try {
        const receipt = cold.rebuild();
        assert.equal(receipt.stateDigest, incrementalDigest, "cold rebuild must match incremental stateDigest");
        assert.equal(receipt.stateDigest, upgradedDigest, "cold rebuild must match v39->v40 upgraded stateDigest");
        assertNoInlineDocumentBodies(coldPath);
        assert.equal(cold.readDocument(seeded.artifactPath).document?.body, seeded.artifactBody);
        assert.equal(cold.readDocumentHistory(seeded.archivedFactPath).document?.body, seeded.archivedFactBody);
        assert.equal(cold.readDecision(seeded.decisionId, true).decision?.body?.body, expectedDecisionProse);
      } finally {
        cold.close();
      }
    } finally {
      upgraded.close();
    }
  });
});

test("L3 fail-closed: missing or corrupted CAS blobs throw structured errors without fabricating empty text", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const seeded = seedSlimProjectionLedger(rootDir, "s3-l3-fail-closed");
    t.after(() => seeded.eventStore.drain());

    const projection = makeTaskProjection({ rootDir, eventStore: seeded.eventStore });
    projection.rebuild();
    const reader = makeTaskProjectionReader({ rootDir, projectionPath: projection.path });
    try {
      // 1. Delete active artifact blob -> content_blob_missing on body read, metadata list still works
      rmSync(casObjectPath(rootDir, seeded.artifactSha));
      assert.throws(
        () => projection.readDocument(seeded.artifactPath),
        (error: unknown) =>
          error instanceof ProjectionContentBlobError &&
          error.code === "content_blob_missing" &&
          error.blobSha256 === seeded.artifactSha &&
          error.documentPath === seeded.artifactPath,
      );
      assert.throws(
        () => reader.withSession((q) => q.readDocument(seeded.artifactPath)),
        (error: unknown) => error instanceof ProjectionContentBlobError && error.code === "content_blob_missing",
      );
      // Metadata-only listings must not touch CAS
      const listed = projection.readDocuments("tasks/").documents;
      assert.equal(
        listed.some((row) => row.path === seeded.artifactPath),
        true,
      );
      assert.equal(projection.readDocumentMetadata(seeded.artifactPath).document?.path, seeded.artifactPath);

      // 2. Delete archived fact blob -> content_blob_missing on readDocumentHistory
      rmSync(casObjectPath(rootDir, seeded.archivedFactSha));
      assert.throws(
        () => projection.readDocumentHistory(seeded.archivedFactPath),
        (error: unknown) =>
          error instanceof ProjectionContentBlobError &&
          error.code === "content_blob_missing" &&
          error.blobSha256 === seeded.archivedFactSha,
      );

      // 3. Tamper with active fact blob (same byte length!) -> content_blob_digest_mismatch
      const activeFactBlobFile = casObjectPath(rootDir, seeded.activeFactSha);
      const originalBytes = Buffer.from(seeded.activeFactBody, "utf8");
      const tamperedSameLen = Buffer.from(originalBytes);
      tamperedSameLen[0] = tamperedSameLen[0]! ^ 0x01;
      writeFileSync(activeFactBlobFile, tamperedSameLen);
      assert.throws(
        () => projection.readDocument(seeded.activeFactPath),
        (error: unknown) =>
          error instanceof ProjectionContentBlobError &&
          error.code === "content_blob_digest_mismatch" &&
          error.blobSha256 === seeded.activeFactSha,
      );

      // 4. Tamper with decision blob (different byte length) -> content_blob_digest_mismatch on withBody=true,
      //    while metadata-only readDecision(..., false) and listDecisions(..., "summary") still succeed without touching CAS
      writeFileSync(casObjectPath(rootDir, seeded.decisionSha), Buffer.from("corrupted", "utf8"));
      assert.throws(
        () => projection.readDecision(seeded.decisionId, true),
        (error: unknown) =>
          error instanceof ProjectionContentBlobError &&
          error.code === "content_blob_digest_mismatch" &&
          error.blobSha256 === seeded.decisionSha,
      );
      assert.equal(projection.readDecision(seeded.decisionId, false).decision?.body, null);
      assert.equal(projection.listDecisions({}, "summary").decisions.length, 1);

      // 5. Tamper with raw binary artifact blob -> content_blob_digest_mismatch (fail-closed even for raw artifacts)
      const tamperedRaw = Uint8Array.from(seeded.rawBytes);
      tamperedRaw[0] = tamperedRaw[0]! ^ 0xff;
      writeFileSync(casObjectPath(rootDir, seeded.rawSha), tamperedRaw);
      assert.throws(
        () => projection.readDocument(seeded.rawPath),
        (error: unknown) =>
          error instanceof ProjectionContentBlobError &&
          error.code === "content_blob_digest_mismatch" &&
          error.blobSha256 === seeded.rawSha,
      );
    } finally {
      reader.close();
      projection.close();
    }
  });
});

test("cold rebuild skips reading full bytes of non-interpreted artifact and fact blobs while preserving metadata and readDocument fidelity", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const seeded = seedSlimProjectionLedger(rootDir, "s3-rebuild-skip-non-interpreted-reads");
    t.after(() => seeded.eventStore.drain());

    const readTargets: string[] = [];
    const statTargets: string[] = [];
    const origReadBytes = localContentObjectFileSystem.readBytes;
    const origSizeBytes = localContentObjectFileSystem.sizeBytes;
    const readSpy = t.mock.method(localContentObjectFileSystem, "readBytes", (target: string) => {
      readTargets.push(target);
      return origReadBytes(target);
    });
    const sizeSpy = t.mock.method(localContentObjectFileSystem, "sizeBytes", (target: string) => {
      statTargets.push(target);
      return origSizeBytes(target);
    });

    const projection = makeTaskProjection({ rootDir, eventStore: seeded.eventStore });
    try {
      const receipt = projection.rebuild();
      assert.equal(receipt.watermark, seeded.bundles.length);

      const artifactFile = casObjectPath(rootDir, seeded.artifactSha);
      const rawFile = casObjectPath(rootDir, seeded.rawSha);
      const activeFactFile = casObjectPath(rootDir, seeded.activeFactSha);
      const decisionFile = casObjectPath(rootDir, seeded.decisionSha);

      // Non-interpreted documents MUST NOT have their full bytes read during cold rebuild
      assert.equal(
        readTargets.includes(artifactFile),
        false,
        "rebuild must not read non-interpreted artifact body bytes",
      );
      assert.equal(readTargets.includes(rawFile), false, "rebuild must not read raw artifact body bytes");
      assert.equal(
        readTargets.includes(activeFactFile),
        false,
        "rebuild must not read non-interpreted fact body bytes",
      );

      // Instead their existence and byte length MUST be verified via stat/sizeBytes
      assert.equal(statTargets.includes(artifactFile), true, "rebuild must stat non-interpreted artifact blob");
      assert.equal(statTargets.includes(rawFile), true, "rebuild must stat raw artifact blob");
      assert.equal(statTargets.includes(activeFactFile), true, "rebuild must stat fact blob");

      // Interpreted Decision document IS read during rebuild for FTS & review summary indexing
      assert.equal(readTargets.includes(decisionFile), true, "rebuild reads interpreted Decision body for FTS/review");

      readSpy.mock.restore();
      sizeSpy.mock.restore();

      // Metadata timeline & on-demand readDocument() still return exact full fidelity
      assertNoInlineDocumentBodies(projection.path);
      const timeline = projection.readArtifactTimelinePage({ kind: "md", limit: 10 });
      assert.equal(timeline.rows.length, 1);
      assert.equal(timeline.rows[0]!.sizeBytes, Buffer.byteLength(seeded.artifactBody));
      assert.equal(projection.readDocument(seeded.artifactPath).document?.body, seeded.artifactBody);
      assert.equal(projection.readDocument(seeded.rawPath).document?.body, "");
      assert.equal(projection.readDocument(seeded.activeFactPath).document?.body, seeded.activeFactBody);
      assert.equal(projection.readDocumentHistory(seeded.archivedFactPath).document?.body, seeded.archivedFactBody);
    } finally {
      readSpy.mock.restore();
      sizeSpy.mock.restore();
      projection.close();
    }
  });
});
