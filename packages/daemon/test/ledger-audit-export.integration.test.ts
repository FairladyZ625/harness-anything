// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAuditChainAccumulator,
  type AuditExportManifestV1,
  type DeliveryCertificateV1,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel";
import {
  verifyAuditSliceContent,
  verifyDeliveryCertificate,
} from "@harness-anything/kernel/internal/integrity/audit-hash-chain.ts";
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

test("ledger-audit-export paginates canonical events across multiple pages and UTC date windows with sha256 and sm3", async () => {
  let currentTime = "2026-11-20T10:00:00.000Z";
  await withCell(
    "export-pages",
    () => currentTime,
    async (cell) => {
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: "task_day1_a", title: "Day 1 A", riskTier: "low" }, binding))
          .outcome,
        "applied",
      );
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: "task_day1_b", title: "Day 1 B", riskTier: "low" }, binding))
          .outcome,
        "applied",
      );
      currentTime = "2026-11-21T15:30:00.000Z";
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: "task_day2_a", title: "Day 2 A", riskTier: "low" }, binding))
          .outcome,
        "applied",
      );

      // Multi-page pagination with limit=2 across entire history (sm3)
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
              limit: 2,
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
      assert.ok(pages >= 2, `expected multi-page export, got ${pages} page(s)`);
      assert.equal(allEvents.length, sourceRevision);
      assert.deepEqual(
        allEvents.map((e) => e.workspaceRevision),
        Array.from({ length: sourceRevision }, (_, i) => i + 1),
      );

      // Date-window slicing + cross-day prevRootHash chaining (sha256)
      const day1Page = evidence(
        await cell.run({ kind: "ledger-audit-export", date: "2026-11-20", algorithm: "sha256" }, binding),
      );
      assert.equal(day1Page.hasMore, false);
      const day1Manifest = day1Page.manifest as AuditExportManifestV1;
      assert.ok(day1Manifest.eventCount >= 2);
      assert.equal(day1Manifest.window.utcDate, "2026-11-20");

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
      assert.ok(day2Manifest.eventCount >= 1);

      // Reconstruct JSONL from returned events and verify offline
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
        }).ok,
        true,
      );

      // Invalid algorithm & limit rejected
      const badAlgo = await cell.run({ kind: "ledger-audit-export", algorithm: "md5" }, binding);
      assert.equal(badAlgo.outcome, "op_rejected");
      const badLimit = await cell.run({ kind: "ledger-audit-export", limit: 501 }, binding);
      assert.equal(badLimit.outcome, "op_rejected");
    },
  );
});

test("task-delivery-certificate exports verifiable certificate for done tasks and rejects non-done tasks", async () => {
  await withCell(
    "delivery-cert",
    () => "2026-11-21T08:00:00.000Z",
    async (cell, rootDir) => {
      const taskId = "task_cert_done";
      const executionId = "exec_cert_done";
      const reviewId = "review_cert_done";

      // Create a docs-task (ledger-only delivery) so completion doesn't require remote git refs
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

      // Realize task_plan.md, start, author closeout, submit, review, consent, and complete
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
        assert.equal(cert.algorithm, algorithm);
        assert.equal(cert.taskId, taskId);
        assert.equal(cert.executionId, executionId);
        assert.equal(cert.status, "done");
        assert.equal(cert.reviews.length, 1);
        assert.equal(cert.reviewConsent?.reviewId, reviewId);
        assert.equal(cert.completion.opId, completed.opId);
        assert.equal(cert.completion.workspaceRevision, completed.revision);

        const verified = verifyDeliveryCertificate(cert, { expectedAlgorithm: algorithm });
        assert.equal(verified.ok, true, JSON.stringify(verified));
      }
    },
  );
});
