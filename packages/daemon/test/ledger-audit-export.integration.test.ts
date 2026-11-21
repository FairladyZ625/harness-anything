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
  reviewDigest,
  serializePersistedCanonicalEvent,
  sha256Text,
  taskLifecycleWritePlan,
  type AuditExportManifestV1,
  type AuditExportWindowV1,
  type DeliveryCertificateV1,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel";
import { normalizePersistedEventValue } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import {
  createMigrationImportEvent,
  migrationImportWritePlan,
} from "@harness-anything/kernel/internal/domain/migration-import-event.ts";
import {
  createAuditCertificateChainCollector,
  verifyAuditSliceContent,
  verifyDeliveryCertificate,
} from "@harness-anything/kernel/internal/integrity/audit-hash-chain.ts";
import { makeTaskEventStore, makeTaskProjection, sqliteLedgerPath } from "@harness-anything/storage";
import { readTaskDeliveryCertificate } from "@harness-anything/application/internal/queries/task-delivery-certificate.ts";
import { readAuditExportPage } from "@harness-anything/application/internal/queries/ledger-audit-export.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
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
    execFileSync("git", ["-C", rootDir, "branch", "-M", "main"]);
    execFileSync("git", ["-C", rootDir, "update-ref", "refs/remotes/origin/main", "HEAD"]);
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
      const fullAcc = createAuditChainAccumulator({
        repoId: String(fullSlice.repoId),
        algorithm: "sha256",
        window: {
          ...(fullSlice.window as AuditExportWindowV1),
          toRevision: Number(fullSlice.effectiveToRevision),
        },
      });
      const fullLines = (fullSlice.events as PersistedCanonicalEventV1[]).map((e) => fullAcc.addEvent(e).line).join("");
      const fullManifest = fullAcc.finalize();
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

test("DM-04 & DM-05: historical imported done task and non-normalized review/consent timestamps verify across hot read and cold rebuild", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-audit-dm04-dm05-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: rootDir });
    execFileSync("git", ["config", "user.name", "Audit Test"], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "audit@example.invalid"], { cwd: rootDir });
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n");
    execFileSync("git", ["add", "."], { cwd: rootDir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: rootDir });

    const repoId = "repo-dm04-dm05";
    const fixture = lifecycleFixture({
      taskId: "task_hist_review_001",
      executionId: "exec_hist_review_001",
      reviewId: "rev_hist_review_001",
    });
    let store = makeTaskEventStore({ rootDir, repoId });
    for (const ev of fixture.events) {
      store.append({ event: ev, plan: taskLifecycleWritePlan(ev), blobs: [] });
    }
    const importedTaskId = "task_imported_done_dm04";
    const docBody = "# Imported Done\n";
    const docSha = sha256Text(docBody);
    const importEvent = createMigrationImportEvent({
      eventId: "event-import-dm04",
      workspaceRevision: fixture.events.length + 1,
      opId: "migration-import-dm04",
      actor: { principal: { personId: "person_zeyu" }, executor: null },
      source: "migration-import/v1",
      occurredAt: "2026-08-19T02:33:20.837Z",
      payload: {
        migratedFrom: importedTaskId,
        generation: "v0",
        entity: {
          kind: "task",
          provenance: "imported_snapshot",
          task: { ...fixture.snapshot.task!, taskId: importedTaskId, status: "done" },
          originalStatus: "done",
          packagePath: `tasks/${importedTaskId}-hist`,
          documentClaim: {
            path: `tasks/${importedTaskId}-hist/INDEX.md`,
            sha256: docSha,
            size: Buffer.byteLength(docBody),
            mediaType: "text/markdown",
            policyId: "typed-migration-import/v1",
          },
        },
      },
    });
    const importPlan = migrationImportWritePlan(importEvent);
    store.append({
      event: importEvent,
      plan: importPlan,
      blobs: [{ sha256: docSha, size: Buffer.byteLength(docBody), mediaType: "text/markdown", body: docBody }],
    });
    await store.drain();

    // Rewrite review_recorded & review_consent_recorded in SQLite with historical +08:00 / no-.sss timestamps (DM-05)
    const db = new DatabaseSync(sqliteLedgerPath(rootDir));
    try {
      const rows = db.prepare("SELECT revision, event_json FROM event ORDER BY revision").all() as Array<{
        readonly revision: number;
        readonly event_json: string;
      }>;
      const updateStmt = db.prepare("UPDATE event SET occurred_at=?, event_json=?, digest=? WHERE revision=?");
      for (const row of rows) {
        const parsed = JSON.parse(row.event_json) as PersistedCanonicalEventV1;
        if (parsed.type === "review_recorded") {
          const updated = {
            ...parsed,
            occurredAt: "2026-08-19T10:33:20+08:00",
            payload: {
              ...parsed.payload,
              review: { ...parsed.payload.review, reviewedAt: "2026-08-19T10:33:20+08:00" },
            },
          };
          const json = serializePersistedCanonicalEvent(updated);
          updateStmt.run(updated.occurredAt, json, `sha256:${sha256Text(json)}`, row.revision);
        } else if (parsed.type === "review_consent_recorded") {
          const normalizedRev = normalizePersistedEventValue({
            ...parsed.payload.review,
            reviewedAt: "2026-08-19T10:33:20+08:00",
          });
          const updated = {
            ...parsed,
            occurredAt: "2026-08-19T02:35:00Z",
            payload: {
              ...parsed.payload,
              review: { ...parsed.payload.review, reviewedAt: "2026-08-19T10:33:20+08:00" },
              consent: {
                ...parsed.payload.consent,
                consentedAt: "2026-08-19T10:35:00+08:00",
                reviewDigest: reviewDigest(normalizedRev),
              },
            },
          };
          const json = serializePersistedCanonicalEvent(updated);
          updateStmt.run(updated.occurredAt, json, `sha256:${sha256Text(json)}`, row.revision);
        }
      }
    } finally {
      db.close();
    }

    store = makeTaskEventStore({ rootDir, repoId });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const makeCell = () => ({
        input: { repoId },
        store,
        projection,
        operationId: (_a: unknown, _b: unknown, _w: string, rev: number) => `op:read:${rev}`,
        readResult: (opId: string, value: object, revision: number) => ({
          schema: "command-receipt/v2" as const,
          ok: true as const,
          command: "read",
          outcome: "applied" as const,
          opId,
          revision,
          evidence: JSON.stringify(value),
          summary: "",
        }),
        cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        requiredCellText: (value: unknown, name: string) => {
          if (typeof value !== "string" || !value) throw new Error(`missing ${name}`);
          return value;
        },
      });
      const queryBinding = {
        actor: { principal: { personId: "person_zeyu" }, executor: null },
        source: "local" as const,
      };

      for (const phase of ["hot", "cold-rebuild"] as const) {
        if (phase === "hot") projection.catchUp();
        else projection.rebuild();
        const cellApi = makeCell();
        const exportReceipt = readAuditExportPage(
          cellApi,
          { kind: "ledger-audit-export", algorithm: "sm3" },
          queryBinding,
        );
        const exported = JSON.parse(String(exportReceipt.evidence)) as {
          readonly events: readonly PersistedCanonicalEventV1[];
          readonly manifest: AuditExportManifestV1;
        };
        const acc = createAuditChainAccumulator({
          repoId,
          algorithm: "sm3",
          window: exported.manifest.window,
        });
        const entriesContent = exported.events.map((e) => acc.addEvent(e).line).join("");
        const manifest = acc.finalize();

        const impCertReceipt = readTaskDeliveryCertificate(
          cellApi,
          { kind: "task-delivery-certificate", taskId: importedTaskId, algorithm: "sha256" },
          queryBinding,
        );
        const impCert = (JSON.parse(String(impCertReceipt.evidence)) as { readonly certificate: DeliveryCertificateV1 })
          .certificate;
        assert.equal(impCert.completionKind, "imported-migration", phase);
        const impCollector = createAuditCertificateChainCollector({
          taskId: importedTaskId,
          completionOpId: impCert.completion.opId,
          executionId: null,
        });
        assert.equal(
          verifyAuditSliceContent({
            manifest,
            entriesContent,
            expectedRootHash: manifest.rootHash,
            certificateCollector: impCollector,
          }).ok,
          true,
        );
        const impVer = verifyDeliveryCertificate(impCert, {
          expectedAlgorithm: "sha256",
          expectedCertificateHash: impCert.certificateHash,
          chainEvidence: impCollector.evidence(),
        });
        assert.equal(impVer.ok, true, `${phase}: ${JSON.stringify(impVer)}`);
        if (impVer.ok) assert.equal(impVer.strictVerified, true);

        const histCertReceipt = readTaskDeliveryCertificate(
          cellApi,
          { kind: "task-delivery-certificate", taskId: "task_hist_review_001", algorithm: "sha256" },
          queryBinding,
        );
        const histCert = (
          JSON.parse(String(histCertReceipt.evidence)) as { readonly certificate: DeliveryCertificateV1 }
        ).certificate;
        assert.equal(histCert.completionKind, "native", phase);
        const histCollector = createAuditCertificateChainCollector({
          taskId: "task_hist_review_001",
          completionOpId: histCert.completion.opId,
          executionId: histCert.executionId,
        });
        assert.equal(
          verifyAuditSliceContent({
            manifest,
            entriesContent,
            expectedRootHash: manifest.rootHash,
            certificateCollector: histCollector,
          }).ok,
          true,
        );
        const histVer = verifyDeliveryCertificate(histCert, {
          expectedAlgorithm: "sha256",
          expectedCertificateHash: histCert.certificateHash,
          chainEvidence: histCollector.evidence(),
        });
        assert.equal(histVer.ok, true, `${phase}: ${JSON.stringify(histVer)}`);
        if (histVer.ok) {
          assert.equal(histVer.strictVerified, true);
          assert.equal(histVer.chainEvidence?.coverage, "complete");
          assert.equal(histVer.chainEvidence?.reviewsVerifiedCount, 1);
          assert.equal(histVer.chainEvidence?.consentVerified, true);
        }
      }
    } finally {
      projection.close();
      await store.drain();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("DM-06: readAuditExportPage records effectiveFromRevision, capped effectiveToRevision, and cursorTruncated on --cursor date windows", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-audit-dm06-cursor-"));
  try {
    initRepo(rootDir);
    const repoId = "repo-dm06-e2e";
    const store = makeTaskEventStore({ rootDir, repoId });
    const fixture = lifecycleFixture({
      taskId: "task_dm06_cursor_001",
      executionId: "exec_dm06_cursor_001",
      reviewId: "rev_dm06_cursor_001",
    });
    const dateForEvent = (revision: number) => {
      const index = revision - 1;
      return index < 2 ? `2026-11-04T1${index}:00:00.000Z` : `2026-11-05T1${index}:00:00.000Z`;
    };
    const reviewEvent = fixture.events.find((event) => event.type === "review_recorded")!;
    const review = { ...reviewEvent.payload.review, reviewedAt: dateForEvent(reviewEvent.workspaceRevision) };
    const splitEvents = fixture.events.map((event) => {
      const occurredAt = dateForEvent(event.workspaceRevision);
      if (event.type === "review_recorded") {
        return { ...event, occurredAt, payload: { ...event.payload, review } };
      }
      if (event.type === "review_consent_recorded") {
        return {
          ...event,
          occurredAt,
          payload: {
            ...event.payload,
            review,
            consent: { ...event.payload.consent, consentedAt: occurredAt, reviewDigest: reviewDigest(review) },
          },
        };
      }
      return { ...event, occurredAt };
    });
    for (const ev of splitEvents) {
      store.append({ event: ev, plan: taskLifecycleWritePlan(ev), blobs: [] });
    }
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      projection.rebuild();
      const queryBinding = { actor, source: "local" as const };
      const cellApi = {
        input: { repoId },
        store,
        projection,
        operationId: (_action: unknown, _b: unknown, id: string, rev: number) => `op-${id}-${rev}`,
        readResult: (opId: string, value: object, revision: number) => ({
          schema: "write-receipt/v1" as const,
          ok: true,
          command: "ledger-audit-export",
          outcome: "applied" as const,
          opId,
          revision,
          evidence: JSON.stringify(value),
        }),
        cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        requiredCellText: (value: unknown, name: string) => {
          if (typeof value !== "string" || !value) throw new Error(`missing ${name}`);
          return value;
        },
      };

      // Pin the real head and the real start revision, then try to skip review by timestamp alone.
      assert.throws(
        () =>
          readAuditExportPage(
            cellApi,
            {
              kind: "ledger-audit-export",
              date: "2026-11-05",
              cursor: `0:${splitEvents.length}:${Date.parse("2026-11-05T14:00:00.000Z")}`,
            },
            queryBinding,
          ),
        { code: "invalid_command" },
      );

      // Day 1 full export (2026-11-04)
      const day1Receipt = readAuditExportPage(
        cellApi,
        { kind: "ledger-audit-export", date: "2026-11-04", algorithm: "sha256", limit: 10 },
        queryBinding,
      );
      const day1Payload = JSON.parse(String(day1Receipt.evidence)) as {
        readonly effectiveFromRevision: number | null;
        readonly effectiveToRevision: number;
        readonly cursorTruncated: boolean;
        readonly events: readonly PersistedCanonicalEventV1[];
      };
      assert.equal(day1Payload.effectiveFromRevision, null);
      assert.equal(day1Payload.effectiveToRevision, splitEvents.length);
      assert.equal(day1Payload.cursorTruncated, false);
      assert.equal(day1Payload.events.length, 2);

      // Day 2 cursor-truncated export (--cursor 4 skips rev 3 submission & rev 4 review on 2026-11-05)
      const day2Receipt = readAuditExportPage(
        cellApi,
        { kind: "ledger-audit-export", date: "2026-11-05", cursor: "4", algorithm: "sha256", limit: 10 },
        queryBinding,
      );
      const day2Payload = JSON.parse(String(day2Receipt.evidence)) as {
        readonly effectiveFromRevision: number | null;
        readonly effectiveToRevision: number;
        readonly cursorTruncated: boolean;
        readonly events: readonly PersistedCanonicalEventV1[];
      };
      assert.equal(day2Payload.effectiveFromRevision, 5);
      assert.equal(day2Payload.effectiveToRevision, splitEvents.length);
      assert.equal(day2Payload.cursorTruncated, true);
      assert.deepEqual(
        day2Payload.events.map((e) => e.workspaceRevision),
        [5, 6],
      );

      // Cursor upper-bound cap (--cursor 3:5 on head 6) MUST cap effectiveToRevision to 5 (never 6)!
      const cappedReceipt = readAuditExportPage(
        cellApi,
        { kind: "ledger-audit-export", date: "2026-11-05", cursor: "3:5", algorithm: "sha256", limit: 10 },
        queryBinding,
      );
      const cappedPayload = JSON.parse(String(cappedReceipt.evidence)) as {
        readonly effectiveFromRevision: number | null;
        readonly effectiveToRevision: number;
        readonly cursorTruncated: boolean;
        readonly events: readonly PersistedCanonicalEventV1[];
      };
      assert.equal(cappedPayload.effectiveFromRevision, 4);
      assert.equal(cappedPayload.effectiveToRevision, 5);
      assert.equal(cappedPayload.cursorTruncated, true);
      assert.deepEqual(
        cappedPayload.events.map((e) => e.workspaceRevision),
        [4, 5],
      );

      // Chain Day 1 + cursor-truncated Day 2 against the real delivery certificate -> partial (not mismatch)!
      const certReceipt = readTaskDeliveryCertificate(
        cellApi,
        { kind: "task-delivery-certificate", taskId: "task_dm06_cursor_001", algorithm: "sha256" },
        queryBinding,
      );
      const cert = (JSON.parse(String(certReceipt.evidence)) as { readonly certificate: DeliveryCertificateV1 })
        .certificate;
      const day1Acc = createAuditChainAccumulator({
        repoId,
        algorithm: "sha256",
        window: {
          fromRevision: day1Payload.effectiveFromRevision,
          toRevision: day1Payload.effectiveToRevision,
          utcDate: "2026-11-04",
          after: "2026-11-04T00:00:00.000Z",
          before: "2026-11-04T23:59:59.999Z",
        },
      });
      const day1Lines = day1Payload.events.map((e) => day1Acc.addEvent(e).line).join("");
      const day1Manifest = day1Acc.finalize();

      const day2Acc = createAuditChainAccumulator({
        repoId,
        algorithm: "sha256",
        prevRootHash: day1Manifest.rootHash,
        window: {
          fromRevision: day2Payload.effectiveFromRevision,
          toRevision: day2Payload.effectiveToRevision,
          utcDate: "2026-11-05",
          after: "2026-11-05T00:00:00.000Z",
          before: "2026-11-05T23:59:59.999Z",
          cursorTruncated: true,
        },
      });
      const day2Lines = day2Payload.events.map((e) => day2Acc.addEvent(e).line).join("");
      const day2Manifest = day2Acc.finalize();

      // A continuation from a truncated plan cannot move its scan origin forward
      // when attached to the full-day revision bounds. It must read the omitted events.
      const partialFirst = JSON.parse(
        String(
          readAuditExportPage(
            cellApi,
            { kind: "ledger-audit-export", date: "2026-11-05", cursor: "4:6", limit: 1 },
            queryBinding,
          ).evidence,
        ),
      ) as {
        readonly page: { readonly nextCursor: string };
      };
      assert.match(partialFirst.page.nextCursor, /^5:6:r[0-9a-f]{32}\.1$/u);
      let cursor: string | null = partialFirst.page.nextCursor.replace(/^5:/u, "0:");
      const fullDay2 = createAuditChainAccumulator({
        repoId,
        algorithm: "sha256",
        prevRootHash: day1Manifest.rootHash,
        window: {
          fromRevision: null,
          toRevision: day2Manifest.window.toRevision,
          utcDate: day2Manifest.window.utcDate,
          after: day2Manifest.window.after,
          before: day2Manifest.window.before,
        },
      });
      const fullRevisions: number[] = [];
      let fullDay2Lines = "";
      while (cursor !== null) {
        const page = JSON.parse(
          String(
            readAuditExportPage(
              cellApi,
              { kind: "ledger-audit-export", date: "2026-11-05", cursor, limit: 1 },
              queryBinding,
            ).evidence,
          ),
        ) as {
          readonly cursorTruncated: boolean;
          readonly events: readonly PersistedCanonicalEventV1[];
          readonly page: { readonly nextCursor: string | null };
        };
        if (fullRevisions.length === 0) assert.equal(page.cursorTruncated, false);
        for (const event of page.events) {
          fullRevisions.push(event.workspaceRevision);
          fullDay2Lines += fullDay2.addEvent(event).line;
        }
        cursor = page.page.nextCursor;
        // A later offset in the same file cannot advance the requested revision.
        if (fullRevisions.length === 1 && cursor !== null) cursor = cursor.replace(/\.[0-9]+$/u, ".2");
      }
      assert.deepEqual(fullRevisions, [3, 4, 5, 6]);

      const fullDay2Manifest = fullDay2.finalize();
      const fullCollector = createAuditCertificateChainCollector({
        taskId: cert.taskId,
        completionOpId: cert.completion.opId,
        executionId: cert.executionId,
      });
      let expectedPrevRootHash = day1Manifest.prevRootHash;
      for (const [manifest, entriesContent] of [
        [day1Manifest, day1Lines],
        [fullDay2Manifest, fullDay2Lines],
      ] as const) {
        const sliceCheck = verifyAuditSliceContent({
          manifest,
          entriesContent,
          expectedPrevRootHash,
          expectedRootHash: manifest.rootHash,
          certificateCollector: fullCollector,
        });
        assert.equal(sliceCheck.ok, true, JSON.stringify(sliceCheck));
        expectedPrevRootHash = manifest.rootHash;
      }
      const fullVerified = verifyDeliveryCertificate(cert, {
        expectedCertificateHash: cert.certificateHash,
        chainEvidence: fullCollector.evidence(),
      });
      assert.equal(fullVerified.ok, true, JSON.stringify(fullVerified));
      if (fullVerified.ok) {
        assert.equal(fullVerified.chainEvidence?.coverage, "complete");
        assert.equal(fullVerified.strictVerified, true);
      }

      const collector = createAuditCertificateChainCollector({
        taskId: "task_dm06_cursor_001",
        completionOpId: cert.completion.opId,
        executionId: cert.executionId,
      });
      assert.equal(
        verifyAuditSliceContent({ manifest: day1Manifest, entriesContent: day1Lines, certificateCollector: collector })
          .ok,
        true,
      );
      assert.equal(
        verifyAuditSliceContent({
          manifest: day2Manifest,
          entriesContent: day2Lines,
          expectedPrevRootHash: day1Manifest.rootHash,
          expectedRootHash: day2Manifest.rootHash,
          certificateCollector: collector,
        }).ok,
        true,
      );
      const verified = verifyDeliveryCertificate(cert, {
        expectedAlgorithm: "sha256",
        expectedCertificateHash: cert.certificateHash,
        chainEvidence: collector.evidence(),
      });
      assert.equal(verified.ok, true, JSON.stringify(verified));
      if (verified.ok) {
        assert.equal(verified.chainEvidence?.coverage, "partial");
        assert.equal(verified.strictVerified, false);
        assert.deepEqual(verified.chainEvidence?.uncoveredReviewIds, ["rev_dm06_cursor_001"]);
        assert.equal(verified.chainEvidence?.consentVerified, true);
      }
    } finally {
      projection.close();
      await store.drain();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
