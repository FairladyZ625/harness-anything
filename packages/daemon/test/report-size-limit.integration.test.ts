// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DOC_SYNC_INLINE_MAX_BYTES,
  makeTaskEventReader,
  makeTaskProjection,
  RAW_ARTIFACT_MAX_BYTES,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { actor, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

type Receipt = Record<string, unknown>;
type DispatchStep = { readonly dispatchId?: string; readonly runtimeSessionId?: string };
const dispatchesOf = (receipt: unknown): DispatchStep[] =>
  (receipt as Record<string, unknown>).dispatches as DispatchStep[];

function reviewerActor(runtimeSessionId: string) {
  return withPolicyGroup(
    {
      actor: {
        principal: owner.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local" as const,
    },
    "admin",
  );
}

// The incident shape: a reviewer-authored report whose body is a Markdown header plus a long tail of
// command-receipt lines, past the doc-sync inline cap. Built like the real 308,204 byte report.
function oversizedReportBody(dispatchId: string): string {
  const receiptLine = `${JSON.stringify({
    schema: "command-receipt/v2",
    ok: true,
    command: "task-show",
    outcome: "applied",
    opId: `read:${taskId}`,
    revision: 149534,
    evidence: "receipt fixture row",
  })}\n`;
  const header = `# Independent closeout review\n\nreviewId: review-${dispatchId}\n\nverdict: approved\n\n`;
  return (
    header + receiptLine.repeat(Math.ceil((DOC_SYNC_INLINE_MAX_BYTES + 4096 - header.length) / receiptLine.length))
  );
}

test("an oversized dispatch report no longer wedges task completion", { timeout: 60_000 }, async () => {
  const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
  try {
    await f.install();
    const receipt = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const { dispatchId, runtimeSessionId } = dispatchesOf(receipt)[0]! as Required<DispatchStep>;

    // The reviewer authors a report past the inline cap and registers its review; the recorded
    // review publishes the whole report into the ledger as one opaque-textual document.
    const packet = `${f.packagePath}/artifacts/reports/${dispatchId}.json`;
    const publishedBody = oversizedReportBody(dispatchId);
    assert.ok(Buffer.byteLength(publishedBody) > DOC_SYNC_INLINE_MAX_BYTES);
    mkdirSync(path.join(f.root, "harness", f.packagePath, "artifacts", "reports"), { recursive: true });
    writeFileSync(f.reportPath(dispatchId), publishedBody);
    writeFileSync(
      path.join(f.root, "harness", packet),
      JSON.stringify({
        verdict: "approved",
        reason: "Inspected the submitted execution and its declared evidence.",
        evidenceChecked: ["submitted execution", "task contract"],
      }),
    );
    const review = await f.cell().run(
      {
        kind: "task-review-execution",
        taskId,
        executionId,
        reviewId: `review-${dispatchId}`,
        fromFile: `harness/${packet}`,
      },
      reviewerActor(runtimeSessionId),
    );
    assert.equal(review.outcome, "applied", JSON.stringify(review));

    // The reviewer runtime appends further receipt lines after the publication, so the worktree
    // drifts past the published document — the exact "M" state of the 308,204 byte incident file.
    const appended = `${JSON.stringify({
      schema: "command-receipt/v2",
      ok: true,
      command: "task-show",
      outcome: "applied",
      evidence: "post-publication append",
    })}\n`.repeat(23);
    writeFileSync(f.reportPath(dispatchId), publishedBody + appended);
    const finalBody = publishedBody + appended;

    const outcome = await f.settleReview(dispatchId, runtimeSessionId, "Reviewed and recorded.");
    assert.equal(outcome, "succeeded");
    assert.equal((await f.consent(`review-${dispatchId}`)).outcome, "applied");

    // The diverged oversized report is a doc-sync candidate, not an invalid document: completion
    // settles it as its own publication step instead of dying on the inline cap.
    const statusRow = rows(
      (await f.run({ kind: "doc-status", paths: [`${f.packagePath}/artifacts/reports/${dispatchId}.md`] })).evidence,
    )[0];
    assert.equal(statusRow?.state, "eligible", JSON.stringify(statusRow));

    const completed = (await f.complete()) as Receipt;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    const reportLogical = `${f.packagePath}/artifacts/reports/${dispatchId}.md`,
      syncedStep = ((completed.steps as readonly Receipt[] | undefined) ?? []).find((step) =>
        JSON.stringify(step.detail ?? {}).includes(reportLogical),
      );
    assert.ok(syncedStep, "completion publishes the oversized report through doc sync itself");
    assert.match(String(syncedStep!.summary ?? ""), /applied count: 1/u);

    // The full report text survives in the canonical projection byte-for-byte, past the cap.
    const reader = makeTaskEventReader({ repoId: workspaceId("completion-review"), rootDir: f.root }),
      projection = makeTaskProjection({ rootDir: f.root, eventStore: reader });
    try {
      const document = projection.readDocument(reportLogical).document;
      assert.equal(document?.body, finalBody);
      assert.ok(Buffer.byteLength(document?.body ?? "") > DOC_SYNC_INLINE_MAX_BYTES);
    } finally {
      await reader.drain();
    }
  } finally {
    await f.close();
  }
});

test("artifacts past the content object contract and prose past the inline cap stay blocked", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-report-size-boundary-"));
  initRepo(rootDir);
  const repoId = workspaceId("report-size-boundary"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "report-size-boundary" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const created = (await cell.run(
      { kind: "task-create", taskId: "task-size-boundary", title: "Size Boundary" },
      binding,
    )) as { readonly outcome: string; readonly packagePath: string };
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const artifact = `${created.packagePath}/artifacts/huge.md`,
      prose = "context/oversized.md",
      artifactTarget = path.join(rootDir, "harness", ...artifact.split("/"));
    mkdirSync(path.dirname(artifactTarget), { recursive: true });
    writeFileSync(
      artifactTarget,
      Buffer.concat([Buffer.from("# Too big\n"), Buffer.alloc(RAW_ARTIFACT_MAX_BYTES + 1, 0x78)]),
    );
    write(rootDir, prose, `# Too big\n${"x".repeat(DOC_SYNC_INLINE_MAX_BYTES + 1)}`);
    const artifactRow = rows((await cell.run({ kind: "doc-status", paths: [artifact] }, binding)).evidence)[0],
      proseRow = rows((await cell.run({ kind: "doc-status", paths: [prose] }, binding)).evidence)[0];
    assert.equal(artifactRow?.state, "blocked", JSON.stringify(artifactRow));
    assert.match(artifactRow?.reason ?? "", new RegExp(`${RAW_ARTIFACT_MAX_BYTES}.*content object contract`, "u"));
    assert.equal(proseRow?.state, "blocked", JSON.stringify(proseRow));
    assert.match(
      proseRow?.reason ?? "",
      new RegExp(`${DOC_SYNC_INLINE_MAX_BYTES}.*inline prose.*split the document`, "u"),
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
