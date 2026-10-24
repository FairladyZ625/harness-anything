// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendIncidentActionReceipt, readIncidentActionReceipt } from "../src/decision-incident-receipt.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");

async function withCell(name: string, run: (cell: Cell, rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${name}-`));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId(name),
      rootDir: canonicalRoot(rootDir),
      ownerId: name,
      now: () => "2026-10-24T06:00:00.000Z",
    });
    await run(cell, rootDir);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function plantNeedsAttentionReceipt(rootDir: string, dispatchId: string): void {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: "task_incident_owner",
    executionId: "execution_incident_owner",
    runtimeSessionId: `runtime_${dispatchId.slice("dispatch_".length)}`,
    instanceId: "instance-codex",
    startedAt: "2026-10-24T05:56:44.000Z",
    binding: { actor: { principal: { personId: "person-owner" } }, source: "local" },
  });
  appendIncidentActionReceipt(rootDir, dispatchId, {
    pointId: "runtime-incident-worker-stop",
    questionVersion: "runtime-incident-disposition/v1",
    status: "applied",
    selected: "needs_attention",
    action: "needs_attention",
    reason: `question: ${dispatchId} needs an owner disposition.`,
    successorDispatchId: null,
    budget: { used: 0, limit: 3, source: "repository" },
    decidedAt: "2026-10-24T05:56:47.000Z",
  });
}

test("runtime-incident-dismiss settles a needs_attention receipt as the owner's no_action", async () => {
  await withCell("incident-dismiss", async (cell, rootDir) => {
    const dispatchId = "dispatch_0123456789abcdef01234567";
    plantNeedsAttentionReceipt(rootDir, dispatchId);
    const dismissed = await cell.run(
      { kind: "runtime-incident-dismiss", dispatchId, reason: "Owner adjudicated: no resume needed." },
      binding,
    );
    assert.equal(dismissed.outcome, "applied", JSON.stringify(dismissed));
    // The visible disposition becomes the owner's no_action with the reason; the automatic
    // disposition's history stays in the stream records and the annotation audit copy.
    const receipt = readIncidentActionReceipt(rootDir, dispatchId);
    assert.equal(receipt?.status, "applied");
    assert.equal(receipt?.action, "no_action");
    assert.equal(receipt?.selected, "no_action");
    assert.equal(receipt?.reason, "Owner adjudicated: no resume needed.");
    // Idempotent: a second close of the already-settled receipt changes nothing.
    const again = await cell.run(
      { kind: "runtime-incident-dismiss", dispatchId, reason: "Owner adjudicated: no resume needed." },
      binding,
    );
    assert.equal(again.outcome, "no_changes", JSON.stringify(again));
    assert.equal(readIncidentActionReceipt(rootDir, dispatchId)?.reason, "Owner adjudicated: no resume needed.");
  });
});

test("runtime-incident-dismiss fail-closes on receipts it cannot settle", async () => {
  await withCell("incident-dismiss-reject", async (cell, rootDir) => {
    const streamless = "dispatch_111111111111111111111111",
      claimed = "dispatch_222222222222222222222222",
      resumeSettled = "dispatch_333333333333333333333333";
    plantNeedsAttentionReceipt(rootDir, claimed);
    appendIncidentActionReceipt(rootDir, claimed, {
      pointId: "runtime-incident-worker-stop",
      questionVersion: "runtime-incident-disposition/v1",
      status: "claimed",
      decidedAt: "2026-10-24T06:05:00.000Z",
    });
    plantNeedsAttentionReceipt(rootDir, resumeSettled);
    appendIncidentActionReceipt(rootDir, resumeSettled, {
      pointId: "runtime-incident-worker-stop",
      questionVersion: "runtime-incident-disposition/v1",
      status: "applied",
      selected: "resume_original",
      action: "resume",
      reason: null,
      successorDispatchId: "dispatch_444444444444444444444444",
      budget: { used: 1, limit: 3, source: "repository" },
      decidedAt: "2026-10-24T06:05:00.000Z",
    });
    // cell.run settles coded failures as op_rejected receipts, so each guard asserts the receipt's
    // code rather than a thrown error.
    const streamlessRun = await cell.run(
      { kind: "runtime-incident-dismiss", dispatchId: streamless, reason: "No receipt here." },
      binding,
    );
    assert.equal(streamlessRun.outcome, "op_rejected", JSON.stringify(streamlessRun));
    assert.equal(streamlessRun.code, "entity_not_found");
    const claimedRun = await cell.run(
      { kind: "runtime-incident-dismiss", dispatchId: claimed, reason: "Claim still in flight." },
      binding,
    );
    assert.equal(claimedRun.outcome, "op_rejected", JSON.stringify(claimedRun));
    assert.equal(claimedRun.code, "content_not_ready");
    // A receipt whose automatic disposition already launched a successor is not awaiting a ruling;
    // closing it again is a no-op, not an overwrite of the settled resume.
    const settled = await cell.run(
      { kind: "runtime-incident-dismiss", dispatchId: resumeSettled, reason: "Already resumed." },
      binding,
    );
    assert.equal(settled.outcome, "no_changes", JSON.stringify(settled));
    assert.equal(readIncidentActionReceipt(rootDir, resumeSettled)?.action, "resume");
  });
});
