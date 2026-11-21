// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createAuditChainAccumulator,
  type AuditExportManifestV1,
  type DeliveryCertificateV1,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel";
import {
  createAuditCertificateChainCollector,
  verifyAuditSliceContent,
  verifyDeliveryCertificate,
} from "@harness-anything/kernel/internal/integrity/audit-hash-chain.ts";
import { sqliteLedgerPath } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
const reviewerBinding = withPolicyGroup(
  {
    actor: {
      principal: { personId: "person-audit-reviewer" },
      executor: { kind: "agent" as const, id: "worker-audit-reviewer" },
    },
    source: "local" as const,
  },
  "maintainer",
);

async function withCell(
  name: string,
  clock: () => string,
  run: (cell: Cell, rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-audit-${name}-`));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    const ledger = path.join(rootDir, "harness");
    mkdirSync(ledger, { recursive: true });
    initRepo(ledger);
    cell = await openRepoCell({
      repoId: workspaceId(name),
      rootDir: canonicalRoot(rootDir),
      ownerId: name,
      now: clock,
    });
    await run(cell, rootDir);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("ledger-audit-export paginates canonical events, enforces cursor bounds & revision contiguity, and bounds UTC date reads", async () => {
  let currentTime = "2026-11-20T10:00:00.000Z";
  await withCell(
    "export-pages",
    () => currentTime,
    async (cell, rootDir) => {
      // Seed historical events on 2026-11-20 with many distinct persons (G4-03 cardinality + bounded date window)
      for (let i = 0; i < 12; i += 1) {
        const personBinding = withPolicyGroup(
          {
            actor: {
              principal: { personId: `person-hist-${String(i).padStart(3, "0")}` },
              executor: { kind: "agent" as const, id: "worker-hist" },
            },
            source: "local" as const,
          },
          "admin",
        );
        assert.equal(
          (
            await cell.run(
              {
                kind: "task-create",
                taskId: `task_day1_${String(i).padStart(2, "0")}`,
                title: `Day 1 ${i}`,
                riskTier: "low",
              },
              personBinding,
            )
          ).outcome,
          "applied",
        );
      }
      currentTime = "2026-11-21T15:30:00.000Z";
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: "task_day2_a", title: "Day 2 A", riskTier: "low" }, binding))
          .outcome,
        "applied",
      );

      // Multi-page pagination with limit=4 across entire history (sm3)
      const allEvents: PersistedCanonicalEventV1[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let sourceRevision: number;
      for (;;) {
        const page = evidence(
          await cell.run(
            {
              kind: "ledger-audit-export",
              algorithm: "sm3",
              limit: 4,
              ...(cursor === null ? {} : { cursor }),
            },
            binding,
          ),
        );
        assert.equal(page.schema, "audit-export-page/v1");
        pages += 1;
        sourceRevision = Number(page.sourceRevision);
        allEvents.push(...(page.events as PersistedCanonicalEventV1[]));
        const next = (page.page as { nextCursor: string | null }).nextCursor;
        if (next === null) break;
        cursor = next;
      }
      assert.ok(pages >= 3, `expected multi-page export, got ${pages} page(s)`);
      assert.equal(allEvents.length, sourceRevision);
      assert.deepEqual(
        allEvents.map((e) => e.workspaceRevision),
        Array.from({ length: sourceRevision }, (_, i) => i + 1),
      );

      // G4-03: Date-window export on 2026-11-21 jumps directly via occurred_at index (1 page, scannedCount === count === 1)
      const day2Direct = evidence(
        await cell.run({ kind: "ledger-audit-export", date: "2026-11-21", algorithm: "sha256", limit: 5 }, binding),
      );
      assert.equal(day2Direct.hasMore, false);
      assert.equal(day2Direct.count, 1);
      assert.equal(day2Direct.scannedCount, 1);

      // Date-window slicing + cross-day prevRootHash chaining (sha256)
      const day1Page = evidence(
        await cell.run({ kind: "ledger-audit-export", date: "2026-11-20", algorithm: "sha256" }, binding),
      );
      assert.equal(day1Page.hasMore, false);
      const day1Manifest = day1Page.manifest as AuditExportManifestV1;
      assert.ok(day1Manifest.eventCount >= 12);
      assert.equal(day1Manifest.window.utcDate, "2026-11-20");
      assert.equal(day1Manifest.attributionStatus, "complete");
      assert.equal("distinctPersonIds" in day1Manifest.personAttribution, false);

      const day2Page = evidence(
        await cell.run(
          {
            kind: "ledger-audit-export",
            date: "2026-11-21",
            algorithm: "sha256",
            prevRootHash: day1Manifest.rootHash,
          },
          binding,
        ),
      );
      assert.equal(day2Page.hasMore, false);
      const day2Manifest = day2Page.manifest as AuditExportManifestV1;
      assert.equal(day2Manifest.prevRootHash, day1Manifest.rootHash);
      assert.equal(day2Manifest.eventCount, 1);

      const acc1 = createAuditChainAccumulator({
        repoId: day1Manifest.repoId,
        algorithm: "sha256",
        window: day1Manifest.window,
      });
      const lines1 = (day1Page.events as PersistedCanonicalEventV1[]).map((e) => acc1.addEvent(e).line).join("");
      assert.equal(verifyAuditSliceContent({ manifest: day1Manifest, entriesContent: lines1 }).ok, true);

      const acc2 = createAuditChainAccumulator({
        repoId: day2Manifest.repoId,
        algorithm: "sha256",
        prevRootHash: day1Manifest.rootHash,
        window: day2Manifest.window,
      });
      const lines2 = (day2Page.events as PersistedCanonicalEventV1[]).map((e) => acc2.addEvent(e).line).join("");
      assert.equal(
        verifyAuditSliceContent({
          manifest: day2Manifest,
          entriesContent: lines2,
          expectedPrevRootHash: day1Manifest.rootHash,
          expectedRootHash: day2Manifest.rootHash,
        }).ok,
        true,
      );

      // G4-05: --cursor below --from-revision MUST be rejected!
      const badCursor = await cell.run({ kind: "ledger-audit-export", fromRevision: 5, cursor: "1" }, binding);
      assert.equal(badCursor.outcome, "op_rejected");
      assert.equal(badCursor.code, "invalid_command");

      // Invalid algorithm & limit rejected
      const badAlgo = await cell.run({ kind: "ledger-audit-export", algorithm: "md5" }, binding);
      assert.equal(badAlgo.outcome, "op_rejected");
      const badLimit = await cell.run({ kind: "ledger-audit-export", limit: 501 }, binding);
      assert.equal(badLimit.outcome, "op_rejected");

      // G4-05: Direct SQLite row deletion BEFORE pure revision export MUST fail with audit_revision_gap!
      const dbPath = sqliteLedgerPath(rootDir, 3);
      const directDb = new DatabaseSync(dbPath);
      try {
        directDb.exec("PRAGMA foreign_keys = OFF;");
        directDb.prepare("DELETE FROM event WHERE revision = 2").run();
      } finally {
        directDb.close();
      }
      const gapExport = await cell.run({ kind: "ledger-audit-export", fromRevision: 1, toRevision: 5 }, binding);
      assert.equal(gapExport.outcome, "op_rejected");
      assert.equal(gapExport.code, "audit_revision_gap");
    },
  );
});

test("task-delivery-certificate exports verifiable native, external-resolution, and sibling-resolution certificates and rejects non-done", async () => {
  await withCell(
    "delivery-cert",
    () => "2026-11-21T08:00:00.000Z",
    async (cell, rootDir) => {
      const taskId = "task_cert_done";
      const executionId = "exec_cert_done";
      const reviewId = "review_cert_done";

      const createReceipt = await cell.run(
        { kind: "task-create", taskId, title: "Cert Done", presetId: "docs-task" },
        binding,
      );
      assert.equal(createReceipt.outcome, "applied", JSON.stringify(createReceipt));
      await waitForFixturePublication(cell, createReceipt.opId, binding);

      // Non-done task MUST be rejected with task_not_done
      const premature = await cell.run({ kind: "task-delivery-certificate", taskId }, binding);
      assert.equal(premature.outcome, "op_rejected");
      assert.equal(premature.code, "task_not_done");

      // Missing task MUST be rejected with entity_not_found
      const missing = await cell.run({ kind: "task-delivery-certificate", taskId: "task_does_not_exist" }, binding);
      assert.equal(missing.outcome, "op_rejected");
      assert.equal(missing.code, "entity_not_found");

      const packagePath = String((createReceipt as { readonly packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        async (documentPath) => {
          const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, binding);
          await waitForFixturePublication(cell, receipt.opId, binding);
          return receipt;
        },
        "Cert Done",
      );

      const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      await waitForFixturePublication(cell, started.opId, binding);

      const ledger = path.join(rootDir, "harness");
      const closeoutPath = path.join(ledger, packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        "# Closeout\n\n## Summary\nDelivered audit certificate fixture.\n\n## Verification\n- Integration test passed.\n\n## Residual Risk\n- None.\n\n## Same Mechanism Elsewhere\n- Checked and not applicable.\n",
      );
      const docSynced = await cell.run({ kind: "doc-submit", taskId }, binding);
      assert.equal(docSynced.outcome, "applied", JSON.stringify(docSynced));
      await waitForFixturePublication(cell, docSynced.opId, binding);

      let submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
      for (let attempt = 0; submitted.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(cell, submitted.opId, binding);
        submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
      }
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      await waitForFixturePublication(cell, submitted.opId, binding);

      const reportDir = path.join(ledger, packagePath, "artifacts", "reports");
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(path.join(reportDir, `${reviewId}.md`), "# Review\n\nApproved.\n");
      const reviewed = await cell.run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId,
          jsonInput: JSON.stringify({
            verdict: "approved",
            reason: "Independent review passed.",
            evidenceChecked: ["closeout.md"],
            findings: [],
            resolutions: [],
          }),
        },
        reviewerBinding,
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

      const consented = await cell.run({ kind: "task-review-consent", taskId, executionId, reviewId }, binding);
      assert.equal(consented.outcome, "applied", JSON.stringify(consented));

      const completed = await cell.run({ kind: "task-complete", taskId }, binding);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));

      // Export full SM3 audit slice, then verify BOTH sha256 and sm3 native certificates against it (G4-02!)
      const sm3SlicePage = evidence(await cell.run({ kind: "ledger-audit-export", algorithm: "sm3" }, binding));
      const sm3Manifest = sm3SlicePage.manifest as AuditExportManifestV1;
      const sm3Acc = createAuditChainAccumulator({
        repoId: sm3Manifest.repoId,
        algorithm: "sm3",
        window: sm3Manifest.window,
      });
      const sm3Lines = (sm3SlicePage.events as PersistedCanonicalEventV1[])
        .map((e) => sm3Acc.addEvent(e).line)
        .join("");

      for (const algorithm of ["sha256", "sm3"] as const) {
        const certReceipt = await cell.run({ kind: "task-delivery-certificate", taskId, algorithm }, binding);
        assert.equal(certReceipt.outcome, "applied", JSON.stringify(certReceipt));
        const envelope = evidence(certReceipt) as {
          readonly schema: string;
          readonly certificate: DeliveryCertificateV1;
        };
        assert.equal(envelope.schema, "task-delivery-certificate/v1");
        const cert = envelope.certificate;
        assert.equal(cert.schema, "delivery-certificate/v1");
        assert.equal(cert.completionKind, "native");
        assert.equal(cert.algorithm, algorithm);
        assert.equal(cert.taskId, taskId);
        assert.equal(cert.executionId, executionId);
        assert.equal(cert.status, "done");
        assert.equal(cert.reviews.length, 1);
        assert.equal(cert.reviewConsent?.reviewId, reviewId);
        assert.equal(cert.completion.opId, completed.opId);
        assert.equal(cert.completion.workspaceRevision, completed.revision);

        const collector = createAuditCertificateChainCollector({
          taskId,
          completionOpId: cert.completion.opId,
          executionId: cert.executionId,
        });
        assert.equal(
          verifyAuditSliceContent({ manifest: sm3Manifest, entriesContent: sm3Lines, certificateCollector: collector })
            .ok,
          true,
        );
        const verified = verifyDeliveryCertificate(cert, {
          expectedAlgorithm: algorithm,
          expectedCertificateHash: cert.certificateHash,
          chainEvidence: collector.evidence(),
        });
        assert.equal(verified.ok, true, JSON.stringify(verified));
      }

      // G4-07: Sibling resolution completion (even after a prior unaccepted execution exists on the task!)
      const factRec = await cell.run(
        {
          kind: "fact-record",
          statement: "Sibling task task_cert_done fully satisfied the requirement.",
          evidenceSource: "integration-test",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
        },
        binding,
      );
      assert.equal(factRec.outcome, "applied", JSON.stringify(factRec));
      const factId = String(evidence(factRec).factId ?? (factRec as { readonly factId?: string }).factId);

      const siblingTaskId = "task_sibling_resolved";
      const sibCreate = await cell.run(
        { kind: "task-create", taskId: siblingTaskId, title: "Sibling Resolved", presetId: "docs-task" },
        binding,
      );
      assert.equal(sibCreate.outcome, "applied", JSON.stringify(sibCreate));
      await waitForFixturePublication(cell, sibCreate.opId, binding);
      const sibPkg = String((sibCreate as { readonly packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        sibPkg,
        async (documentPath) => {
          const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, binding);
          await waitForFixturePublication(cell, receipt.opId, binding);
          return receipt;
        },
        "Sibling Resolved",
      );
      // Start & submit an unaccepted execution first to prove G4-07 NEVER fabricates it into the sibling certificate!
      const sibStart = await cell.run(
        { kind: "task-start", taskId: siblingTaskId, executionId: "exec_sib_unaccepted" },
        binding,
      );
      assert.equal(sibStart.outcome, "applied", JSON.stringify(sibStart));
      await waitForFixturePublication(cell, sibStart.opId, binding);
      writeFileSync(
        path.join(ledger, sibPkg, "closeout.md"),
        "# Closeout\n\n## Summary\nDraft.\n\n## Verification\n- Draft.\n\n## Residual Risk\n- None.\n\n## Same Mechanism Elsewhere\n- None.\n",
      );
      const sibDoc = await cell.run({ kind: "doc-submit", taskId: siblingTaskId }, binding);
      assert.equal(sibDoc.outcome, "applied", JSON.stringify(sibDoc));
      await waitForFixturePublication(cell, sibDoc.opId, binding);
      let sibSub = await cell.run(
        { kind: "task-submit", taskId: siblingTaskId, executionId: "exec_sib_unaccepted" },
        binding,
      );
      for (let attempt = 0; sibSub.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(cell, sibSub.opId, binding);
        sibSub = await cell.run(
          { kind: "task-submit", taskId: siblingTaskId, executionId: "exec_sib_unaccepted" },
          binding,
        );
      }
      assert.equal(sibSub.outcome, "applied", JSON.stringify(sibSub));

      const sibComplete = await cell.run(
        {
          kind: "task-complete",
          taskId: siblingTaskId,
          resolvedBy: taskId,
          resolutionRationale: "Delivered by sibling task_cert_done.",
          resolutionFact: `fact/${factId}`,
        },
        binding,
      );
      assert.equal(sibComplete.outcome, "applied", JSON.stringify(sibComplete));

      const sibCertReceipt = await cell.run(
        { kind: "task-delivery-certificate", taskId: siblingTaskId, algorithm: "sm3" },
        binding,
      );
      assert.equal(sibCertReceipt.outcome, "applied", JSON.stringify(sibCertReceipt));
      const sibCert = (evidence(sibCertReceipt) as { readonly certificate: DeliveryCertificateV1 }).certificate;
      assert.equal(sibCert.completionKind, "sibling-resolution");
      assert.equal(sibCert.executionId, null);
      assert.equal(sibCert.submission, null);
      assert.equal(sibCert.submissionDigest, null);
      assert.equal(sibCert.resolution?.kind, "sibling-resolution");
      assert.equal(sibCert.resolution?.sourceTaskId, taskId);

      // G4-07: External-resolution completion (by existing commit SHA, with zero native executions!)
      const extTaskId = "task_external_resolved";
      const extCreate = await cell.run(
        { kind: "task-create", taskId: extTaskId, title: "External Resolved", presetId: "docs-task" },
        binding,
      );
      assert.equal(extCreate.outcome, "applied", JSON.stringify(extCreate));
      await waitForFixturePublication(cell, extCreate.opId, binding);
      const extPkg = String((extCreate as { readonly packagePath?: string }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        extPkg,
        async (documentPath) => {
          const receipt = await cell.run({ kind: "doc-submit", paths: [documentPath] }, binding);
          await waitForFixturePublication(cell, receipt.opId, binding);
          return receipt;
        },
        "External Resolved",
      );
      const repoHeadSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const extComplete = await cell.run(
        {
          kind: "task-complete",
          taskId: extTaskId,
          resolvedBy: repoHeadSha,
          resolutionRationale: "Landed via external commit.",
          resolutionFact: `fact/${factId}`,
        },
        binding,
      );
      assert.equal(extComplete.outcome, "applied", JSON.stringify(extComplete));

      const extCertReceipt = await cell.run(
        { kind: "task-delivery-certificate", taskId: extTaskId, algorithm: "sm3" },
        binding,
      );
      assert.equal(extCertReceipt.outcome, "applied", JSON.stringify(extCertReceipt));
      const extCert = (evidence(extCertReceipt) as { readonly certificate: DeliveryCertificateV1 }).certificate;
      assert.equal(extCert.completionKind, "external-resolution");
      assert.equal(extCert.executionId, null);
      assert.equal(extCert.submission, null);
      assert.equal(extCert.commitSha, repoHeadSha);
      assert.equal(extCert.resolution?.kind, "external-resolution");
      assert.equal(extCert.resolution?.commitSha, repoHeadSha);

      // Cross-verify both sibling & external resolution certificates against exported sha256 audit slice
      const fullSlice = evidence(await cell.run({ kind: "ledger-audit-export", algorithm: "sha256" }, binding));
      const fullManifest = fullSlice.manifest as AuditExportManifestV1;
      const fullAcc = createAuditChainAccumulator({
        repoId: fullManifest.repoId,
        algorithm: "sha256",
        window: fullManifest.window,
      });
      const fullLines = (fullSlice.events as PersistedCanonicalEventV1[]).map((e) => fullAcc.addEvent(e).line).join("");
      for (const [resTaskId, resCert] of [
        [siblingTaskId, sibCert],
        [extTaskId, extCert],
      ] as const) {
        const resCollector = createAuditCertificateChainCollector({
          taskId: resTaskId,
          completionOpId: resCert.completion.opId,
          executionId: null,
        });
        assert.equal(
          verifyAuditSliceContent({
            manifest: fullManifest,
            entriesContent: fullLines,
            certificateCollector: resCollector,
          }).ok,
          true,
        );
        const resVerified = verifyDeliveryCertificate(resCert, {
          expectedAlgorithm: "sm3",
          expectedCertificateHash: resCert.certificateHash,
          chainEvidence: resCollector.evidence(),
        });
        assert.equal(resVerified.ok, true, JSON.stringify(resVerified));
      }
    },
  );
});
