// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileDecisionWrite,
  reduceDecisionDocument,
  decisionReviewContentDigest,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  makeTaskEventStore,
  makeTaskProjection,
  makeTaskProjectionReader,
  readNodeMaterializationDocuments,
  applyCanonicalTree,
} from "../../src/index.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { decisionReviewState } from "@harness-anything/kernel/internal/ports/decision-projection-model.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { proposal, fact } from "./relation-graph-projection.fixtures.ts";

// The real event follower and a later cold pass must both settle directory shells.
test("Decision retirement prunes empty shells and preserves unindexed legacy bytes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    let projection: ReturnType<typeof makeTaskProjection> | null = null;
    const repoId = "decision-directory-materialization",
      decisionId = "dec_DIRECTORY",
      logicalRoot = `decisions/decision-${decisionId}`,
      root = path.join(rootDir, "harness"),
      directory = path.join(root, logicalRoot),
      emptyShell = path.join(root, "decisions/decision-dec_EMPTY"),
      strayShell = path.join(root, "decisions/decision-dec_STRAY"),
      store = makeTaskEventStore({
        repoId,
        rootDir,
        readMaterializationDocuments: (forced, afterRevision, expectedRevision, previous) => {
          if (!projection) return null;
          return makeTaskProjectionReader({ rootDir, projectionPath: projection.path }).withSession((q) =>
            q.readCut().watermark !== expectedRevision
              ? null
              : readNodeMaterializationDocuments(q, "include_done", forced, afterRevision, previous),
          );
        },
      });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const proposed = compileDecisionWrite({
        event: (() => {
          const draft = proposal(1, decisionId);
          if (draft.type !== "decision_proposed") throw new Error("expected proposal fixture");
          return { ...draft, payload: { ...draft.payload, provenance: fact(1).payload.provenance } };
        })(),
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
        decisionReviewRequirement: "off",
      });
      store.append(proposed);
      projection.apply(proposed.event, proposed.plan);
      const assertReviewCut = () => {
        const summary = projection!.listDecisions({}, "review").decisions[0]!,
          detail = projection!.readDecision(decisionId).decision!;
        assert.equal(summary.body, null);
        assert.ok(summary.listReview?.digest);
        for (const requirement of ["all", "medium_and_high", "high", "off"] as const)
          assert.deepEqual(decisionReviewState(summary, requirement), decisionReviewState(detail, requirement));
      };
      assertReviewCut();
      await store.settlePendingMaterialization?.("create Decision");
      assert.ok(existsSync(path.join(directory, "decision.md")));
      const current = reduceDecisionDocument(null, proposed.event),
        reportPath = `${logicalRoot}/artifacts/reports/review.md`,
        reportBody = "# Canonical review\n\nRetain this evidence in history.\n",
        reportClaim = {
          sha256: sha256Text(reportBody),
          size: Buffer.byteLength(reportBody),
          mediaType: "text/markdown",
        },
        reviewed = compileDecisionWrite({
          event: {
            ...proposal(2, decisionId),
            type: "decision_review_recorded",
            payload: {
              reviewId: "review-directory",
              reviewContentDigest: decisionReviewContentDigest(current, proposed.body),
              verdict: "approved",
              reason: "Reviewed directory retirement",
              findings: [],
              evidenceChecked: ["CH1"],
              reportRef: reportPath,
              carriedDocumentClaims: [
                {
                  path: reportPath,
                  baseBlobSha256: null,
                  candidate: reportClaim,
                  policyId: "opaque-textual-whole-file/v1",
                  regionProofs: [],
                },
              ],
            },
          },
          currentDecision: current,
          currentRelations: [],
          currentDocument: { blobSha256: proposed.event.payload.decisionDocumentClaim.sha256, body: proposed.body },
          decisionReviewRequirement: "off",
        });
      store.append({ ...reviewed, blobs: [...reviewed.blobs, { ...reportClaim, body: reportBody }] });
      projection.apply(reviewed.event, reviewed.plan);
      assertReviewCut();
      await store.settlePendingMaterialization?.("create canonical review");
      assert.equal(readFileSync(path.join(root, reportPath), "utf8"), reportBody);
      const retired = compileDecisionWrite({
        event: {
          ...proposal(3, decisionId),
          type: "decision_rejected",
          actor: { principal: { personId: "arbiter" }, executor: null },
          payload: { reason: "retire directory" },
        },
        currentDecision: reduceDecisionDocument(current, reviewed.event),
        currentRelations: [],
        currentDocument: { blobSha256: reviewed.event.payload.decisionDocumentClaim.sha256, body: reviewed.body },
        decisionReviewRequirement: "off",
      });
      store.append(retired);
      projection.apply(retired.event, retired.plan);
      assertReviewCut();
      await store.settlePendingMaterialization?.("retire Decision");
      assert.equal(existsSync(directory), false, "incremental retirement removes the empty Decision directory");
      assert.equal(projection.readDocumentHistory(reportPath).document?.body, reportBody);
      mkdirSync(emptyShell, { recursive: true });
      mkdirSync(strayShell, { recursive: true });
      writeFileSync(path.join(strayShell, "legacy-report.md"), "unindexed user bytes\n");
      store.materialize({ preview: true });
      assert.ok(existsSync(emptyShell), "preview cannot remove directories");
      store.materialize();
      assert.equal(existsSync(emptyShell), false, "cold materialize reconciles shells absent from Git's tree");
      assert.equal(readFileSync(path.join(strayShell, "legacy-report.md"), "utf8"), "unindexed user bytes\n");
    } finally {
      await store.drain();
      projection.close();
    }
  });
});

test("canonical tree followers prune retired report parents and cold empty shells", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const layout = resolveHarnessLayout({ rootDir, layoutOverrides: { authoredRoot: "authored" } }),
      authoredRoot = layout.authoredRoot,
      markerPath = path.join(rootDir, "marker.json"),
      logical = "decisions/decision-dec_TREE/artifacts/reports/review.md",
      body = "canonical review\n",
      input = {
        layout,
        markerPath,
        generation: 1,
        revision: 1,
        entries: new Map([[logical, { sha256: sha256Text(body) }]]),
        readContent: () => Buffer.from(body),
      };
    applyCanonicalTree(input);
    const empty = path.join(authoredRoot, "decisions/decision-dec_EMPTY"),
      stray = path.join(authoredRoot, "decisions/decision-dec_STRAY");
    mkdirSync(empty);
    mkdirSync(stray);
    writeFileSync(path.join(stray, "legacy.md"), "unindexed bytes");
    const retired = { ...input, revision: 2, entries: new Map(), changedPaths: [logical] };
    applyCanonicalTree({ ...retired, preview: true });
    assert.ok(existsSync(path.join(authoredRoot, logical)), "preview preserves canonical files");
    applyCanonicalTree(retired);
    assert.equal(existsSync(path.join(authoredRoot, "decisions/decision-dec_TREE")), false);
    assert.ok(existsSync(empty), "incremental settlement only touches retired path parents");
    applyCanonicalTree({ ...input, revision: 2, entries: new Map() });
    assert.equal(existsSync(empty), false);
    assert.equal(readFileSync(path.join(stray, "legacy.md"), "utf8"), "unindexed bytes");
  });
});

test("canonical tree prunes nested empty decision subdirs and deletes only verified historical copies", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const layout = resolveHarnessLayout({ rootDir, layoutOverrides: { authoredRoot: "authored" } }),
      authoredRoot = layout.authoredRoot,
      markerPath = path.join(rootDir, "marker.json"),
      retiredPath = "decisions/decision-dec_NEST/artifacts/reports/review.md",
      modifiedPath = "decisions/decision-dec_DIRTY/artifacts/reports/edited.md",
      coldMatchPath = "decisions/decision-dec_COLD/artifacts/reports/archived.md",
      coldDirtyPath = "decisions/decision-dec_COLD_DIRTY/artifacts/reports/local.md",
      unindexedPath = "decisions/decision-dec_UNINDEXED/artifacts/reports/new.md",
      nestedEmpty = path.join(authoredRoot, "decisions/decision-dec_SHELL/artifacts/empty/deep"),
      bodyA = "canonical review\n",
      bodyB = "original ingested\n",
      bodyC = "archived copy\n",
      historical = new Map([
        [coldMatchPath, { blobSha256: sha256Text(bodyC) }],
        [coldDirtyPath, { blobSha256: sha256Text(bodyB) }],
      ]);

    applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 1,
      entries: new Map([
        [retiredPath, { sha256: sha256Text(bodyA) }],
        [modifiedPath, { sha256: sha256Text(bodyB) }],
      ]),
      readContent: (logical) => Buffer.from(logical === retiredPath ? bodyA : bodyB),
    });

    // Simulate un-pruned nested empty dir under dec_NEST plus local edit on dec_DIRTY.
    mkdirSync(path.join(authoredRoot, "decisions/decision-dec_NEST/artifacts/empty/deep"), { recursive: true });
    writeFileSync(path.join(authoredRoot, modifiedPath), "local uncommitted edit\n");

    const incremental = applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 2,
      entries: new Map(),
      changedPaths: [retiredPath, modifiedPath],
      acceptedRetired: new Map([[modifiedPath, sha256Text(bodyB)]]),
      readContent: () => Buffer.alloc(0),
    });
    assert.equal(
      existsSync(path.join(authoredRoot, "decisions/decision-dec_NEST")),
      false,
      "incremental retirement recursively prunes nested empty artifacts subdirectories",
    );
    assert.equal(
      readFileSync(path.join(authoredRoot, modifiedPath), "utf8"),
      "local uncommitted edit\n",
      "incremental retirement never deletes locally edited files whose sha256 differs from acceptedRetired",
    );
    assert.ok(incremental.dirtyPaths.includes(modifiedPath));

    // Cold pass: nested empty shell, exact historical match, modified historical file, and unindexed local file.
    mkdirSync(nestedEmpty, { recursive: true });
    mkdirSync(path.dirname(path.join(authoredRoot, coldMatchPath)), { recursive: true });
    writeFileSync(path.join(authoredRoot, coldMatchPath), bodyC);
    mkdirSync(path.dirname(path.join(authoredRoot, coldDirtyPath)), { recursive: true });
    writeFileSync(path.join(authoredRoot, coldDirtyPath), "user modified after archive\n");
    mkdirSync(path.dirname(path.join(authoredRoot, unindexedPath)), { recursive: true });
    writeFileSync(path.join(authoredRoot, unindexedPath), "un-ingested report\n");

    const cold = applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 2,
      entries: new Map(),
      readHistoricalDocument: (logical) => historical.get(logical) ?? null,
      readContent: () => Buffer.alloc(0),
    });
    assert.equal(
      existsSync(path.join(authoredRoot, "decisions/decision-dec_SHELL")),
      false,
      "cold pass recursively prunes nested empty decision shells bottom-up",
    );
    assert.equal(
      existsSync(path.join(authoredRoot, "decisions/decision-dec_COLD")),
      false,
      "cold pass removes stale previously-ingested files matching document_history sha256",
    );
    assert.equal(
      readFileSync(path.join(authoredRoot, coldDirtyPath), "utf8"),
      "user modified after archive\n",
      "cold pass preserves modified historical files",
    );
    assert.ok(cold.dirtyPaths.includes(coldDirtyPath));
    assert.equal(
      readFileSync(path.join(authoredRoot, unindexedPath), "utf8"),
      "un-ingested report\n",
      "cold pass never blind-deletes un-ingested local reports",
    );
  });
});

test("terminal-materialization-v1 upgrade converges legacy zero-hold retired Decision and artifacts to dematerialized_terminal", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    let projection: ReturnType<typeof makeTaskProjection> | null = null;
    const repoId = "legacy-v1-decision-upgrade",
      decisionId = "dec_LEGACY_V1",
      logicalRoot = `decisions/decision-${decisionId}`,
      reportPath = `${logicalRoot}/artifacts/reports/review.md`,
      reportBody = "# Legacy report\n\nNeeds archive on v1->v2 upgrade.\n",
      reportClaim = {
        sha256: sha256Text(reportBody),
        size: Buffer.byteLength(reportBody),
        mediaType: "text/markdown",
      },
      store = makeTaskEventStore({
        repoId,
        rootDir,
        readMaterializationDocuments: (forced, afterRevision, expectedRevision, previous) => {
          if (!projection) return null;
          return makeTaskProjectionReader({ rootDir, projectionPath: projection.path }).withSession((q) =>
            q.readCut().watermark !== expectedRevision
              ? null
              : readNodeMaterializationDocuments(q, "include_done", forced, afterRevision, previous),
          );
        },
      });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const projectionPath = projection.path;
    try {
      const proposed = compileDecisionWrite({
        event: (() => {
          const draft = proposal(1, decisionId);
          if (draft.type !== "decision_proposed") throw new Error("expected proposal fixture");
          return { ...draft, payload: { ...draft.payload, provenance: fact(1).payload.provenance } };
        })(),
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
        decisionReviewRequirement: "off",
      });
      store.append(proposed);
      projection.apply(proposed.event, proposed.plan);

      const current = reduceDecisionDocument(null, proposed.event),
        reviewed = compileDecisionWrite({
          event: {
            ...proposal(2, decisionId),
            type: "decision_review_recorded",
            payload: {
              reviewId: "review-legacy-v1",
              reviewContentDigest: decisionReviewContentDigest(current, proposed.body),
              verdict: "approved",
              reason: "Legacy artifact coverage",
              findings: [],
              evidenceChecked: ["CH1"],
              reportRef: reportPath,
              carriedDocumentClaims: [
                {
                  path: reportPath,
                  baseBlobSha256: null,
                  candidate: reportClaim,
                  policyId: "opaque-textual-whole-file/v1",
                  regionProofs: [],
                },
              ],
            },
          },
          currentDecision: current,
          currentRelations: [],
          currentDocument: { blobSha256: proposed.event.payload.decisionDocumentClaim.sha256, body: proposed.body },
          decisionReviewRequirement: "off",
        });
      store.append({ ...reviewed, blobs: [...reviewed.blobs, { ...reportClaim, body: reportBody }] });
      projection.apply(reviewed.event, reviewed.plan);

      const retired = compileDecisionWrite({
        event: {
          ...proposal(3, decisionId),
          type: "decision_rejected",
          actor: { principal: { personId: "arbiter" }, executor: null },
          payload: { reason: "retire legacy" },
        },
        currentDecision: reduceDecisionDocument(current, reviewed.event),
        currentRelations: [],
        currentDocument: { blobSha256: reviewed.event.payload.decisionDocumentClaim.sha256, body: reviewed.body },
        decisionReviewRequirement: "off",
      });
      store.append(retired);
      projection.apply(retired.event, retired.plan);
      await store.settlePendingMaterialization?.("settle before simulating legacy v1 state");

      // Re-open raw SQLite to simulate a pre-fix DB whose v1 migration marked the retired Decision
      // still materialized while leaving decision.md + artifacts in active document rows (and on disk).
      const activeDecisionDoc = projection.readDocumentHistory(`${logicalRoot}/decision.md`).document!,
        activeReportDoc = projection.readDocumentHistory(reportPath).document!;
      assert.ok(activeDecisionDoc && activeReportDoc);
      projection.close();

      const raw = new DatabaseSync(projectionPath);
      try {
        raw
          .prepare(
            `UPDATE projection_maintenance
                SET key = 'terminal-materialization-v1'
              WHERE key = 'terminal-materialization-v2'`,
          )
          .run();
        raw
          .prepare(
            `INSERT OR REPLACE INTO document(path, workspace_revision, value_json)
             SELECT path, workspace_revision, value_json
               FROM document_history
              WHERE path IN (?, ?)`,
          )
          .run(`${logicalRoot}/decision.md`, reportPath);
        raw.prepare(`DELETE FROM document_history WHERE path IN (?, ?)`).run(`${logicalRoot}/decision.md`, reportPath);
      } finally {
        raw.close();
      }

      // Write stale previously-ingested files + nested empty dir on disk before cold store.materialize().
      const decisionDir = path.join(rootDir, "harness", logicalRoot);
      mkdirSync(path.join(decisionDir, "artifacts/empty/deep"), { recursive: true });
      mkdirSync(path.join(decisionDir, "artifacts/reports"), { recursive: true });
      writeFileSync(path.join(rootDir, "harness", `${logicalRoot}/decision.md`), activeDecisionDoc.body);
      writeFileSync(path.join(rootDir, "harness", reportPath), reportBody);

      projection = makeTaskProjection({ rootDir, eventStore: store });
      assert.equal(projection.readDecision(decisionId).decision?.materializationState, "dematerialized_terminal");
      assert.equal(projection.readDocument(`${logicalRoot}/decision.md`).document, null);
      assert.equal(projection.readDocument(reportPath).document, null);
      assert.equal(projection.readDocumentHistory(`${logicalRoot}/decision.md`).document?.body, activeDecisionDoc.body);
      assert.equal(projection.readDocumentHistory(reportPath).document?.body, reportBody);

      store.materialize();
      assert.equal(existsSync(decisionDir), false, "cold materialize after v1->v2 upgrade clears legacy files & dirs");
    } finally {
      await store.drain();
      projection.close();
    }
  });
});
