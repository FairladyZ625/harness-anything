// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
