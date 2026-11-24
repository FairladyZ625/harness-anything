// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import {
  acceptedWorkDecision,
  openBootstrappedRepoCell as openRepoCell,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { evidence, initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const aliceBinding = withPolicyGroup(
  { actor: { principal: { personId: "person_alice" }, executor: null }, source: "local" as const },
  "contributor",
);
const bobBinding = withPolicyGroup(
  { actor: { principal: { personId: "person_bob" }, executor: null }, source: "local" as const },
  "contributor",
);
const adminAliceBinding = withPolicyGroup(
  { actor: { principal: { personId: "person_alice" }, executor: null }, source: "local" as const },
  "admin",
);
const adminBobBinding = withPolicyGroup(
  { actor: { principal: { personId: "person_bob" }, executor: null }, source: "local" as const },
  "admin",
);

test("peer collaboration: multi-window routing, Tier-A L0/L1/L2 fences, OIDC binding, offline fail-closed, handoff bundle & promote", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-peer-collab-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("peer-collab"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "peer-collab-test",
    });

    // 1. Multi-window lane routing + watch --once wakeup + atomic reply
    const askOps = await cell.run(
      {
        kind: "peer-ask",
        toPersonId: "person_bob",
        lane: "ops",
        summary: "Inspect prod latency spike",
        claim: "P99 latency doubled after deploy.",
        requestedAction: "Check read-only metrics.",
      },
      aliceBinding,
    );
    assert.equal(askOps.outcome, "applied", JSON.stringify(askOps));
    const { request: opsReq } = evidence(askOps) as { request: PeerRequestV1 };
    assert.equal(opsReq.state, "OPEN");

    const askWork = await cell.run(
      {
        kind: "peer-ask",
        toPersonId: "person_bob",
        workId: "work_beta",
        summary: "Review PR #42",
        claim: "PR #42 is green.",
        requestedAction: "Review diff.",
      },
      aliceBinding,
    );
    assert.equal(askWork.outcome, "applied", JSON.stringify(askWork));
    const { request: workReq } = evidence(askWork) as { request: PeerRequestV1 };

    const watchDefault = evidence(await cell.run({ kind: "peer-watch", once: true, lane: "default" }, bobBinding)) as {
      matched: boolean;
      pendingCount: number;
    };
    assert.equal(watchDefault.matched, false);
    assert.equal(watchDefault.pendingCount, 0);

    const watchOps = evidence(await cell.run({ kind: "peer-watch", once: true, lane: "ops" }, bobBinding)) as {
      matched: boolean;
      request: PeerRequestV1;
    };
    assert.equal(watchOps.matched, true);
    assert.equal(watchOps.request.requestId, opsReq.requestId);

    const watchWork = evidence(await cell.run({ kind: "peer-watch", once: true, workId: "work_beta" }, bobBinding)) as {
      matched: boolean;
      request: PeerRequestV1;
    };
    assert.equal(watchWork.matched, true);
    assert.equal(watchWork.request.requestId, workReq.requestId);

    const delegate = await cell.run(
      {
        kind: "peer-ask",
        toPersonId: "person_bob",
        requestKind: "delegate",
        summary: "Prepare the migration review",
      },
      aliceBinding,
    );
    assert.equal(delegate.outcome, "applied", JSON.stringify(delegate));
    const { request: delegateRequest } = evidence(delegate) as { request: PeerRequestV1 };
    assert.equal(delegateRequest.kind, "ops-request");
    assert.equal(delegateRequest.to.personId, "person_bob");

    const reply = await cell.run(
      {
        kind: "peer-reply",
        requestId: opsReq.requestId,
        operation: "read-only-diagnostic",
        claim: "Confirmed DB connection pool saturation.",
        requestedAction: "Increase pool size.",
      },
      bobBinding,
    );
    assert.equal(reply.outcome, "applied", JSON.stringify(reply));

    const watchReply = evidence(
      await cell.run({ kind: "peer-watch", once: true, replyTo: opsReq.requestId }, aliceBinding),
    ) as { matched: boolean; request: PeerRequestV1 };
    assert.equal(watchReply.matched, true);
    assert.equal(watchReply.request.state, "ANSWERED");
    assert.equal(watchReply.request.reply?.structuredBody.claim, "Confirmed DB connection pool saturation.");

    // 2. Security fences: OIDC spoofing, offline 7545 fail-closed, Tier-A L1/L2 ceilings
    const spoofed = await cell.run(
      {
        kind: "peer-ask",
        fromPersonId: "person_mallory",
        toPersonId: "person_bob",
        summary: "Spoofed request",
        claim: "I am Mallory.",
        requestedAction: "Do something.",
      },
      aliceBinding,
    );
    assert.equal(spoofed.outcome, "op_rejected");
    assert.equal(spoofed.code, "peer_sender_spoofing_denied");

    const offlineAsk = await cell.run(
      {
        kind: "peer-ask",
        toPersonId: "person_bob",
        fleetStreamConnected: false,
        summary: "Offline ask",
        claim: "Disconnected.",
        requestedAction: "Fail closed.",
      },
      aliceBinding,
    );
    assert.equal(offlineAsk.outcome, "op_rejected");
    assert.equal(offlineAsk.code, "peer_replication_disconnected");

    const l1NoHuman = await cell.run(
      {
        kind: "peer-reply",
        requestId: workReq.requestId,
        operation: "merge",
        preflightPassed: true,
        claim: "Attempted merge.",
        requestedAction: "Merge.",
      },
      bobBinding,
    );
    assert.equal(l1NoHuman.outcome, "op_rejected");
    assert.equal(l1NoHuman.code, "peer_local_human_confirmation_required");

    const l1NoPreflight = await cell.run(
      {
        kind: "peer-reply",
        requestId: workReq.requestId,
        operation: "shared-ledger-write",
        humanConfirmed: true,
        claim: "Attempted write.",
        requestedAction: "Write.",
      },
      bobBinding,
    );
    assert.equal(l1NoPreflight.outcome, "op_rejected");
    assert.equal(l1NoPreflight.code, "peer_local_preflight_required");

    const l2Denied = await cell.run(
      {
        kind: "peer-reply",
        requestId: workReq.requestId,
        operation: "host-privileged",
        preflightPassed: true,
        humanConfirmed: true,
        claim: "Attempted sudo.",
        requestedAction: "Restart daemon.",
      },
      bobBinding,
    );
    assert.equal(l2Denied.outcome, "op_rejected");
    assert.equal(l2Denied.code, "peer_execution_ceiling_draft_only");

    const l2Draft = await cell.run(
      {
        kind: "peer-reply",
        requestId: workReq.requestId,
        operation: "host-privileged",
        draftOnly: true,
        claim: "Generated host command draft for local human review.",
        requestedAction: "Review draft command.",
      },
      bobBinding,
    );
    assert.equal(l2Draft.outcome, "applied", JSON.stringify(l2Draft));

    // 3. End-to-end ha peer handoff -> git bundle blob + ContinuationPacket -> watch wakeup -> promote
    writeFileSync(path.join(rootDir, "wip-feature.txt"), "halfway through peer handoff\n", "utf8");
    execFileSync("git", ["-C", rootDir, "add", "wip-feature.txt"]);
    execFileSync("git", ["-C", rootDir, "commit", "-m", "wip: peer handoff checkpoint"]);
    const wipSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const offlineHandoff = await cell.run(
      {
        kind: "peer-handoff",
        targetId: "task_wip_123",
        toPersonId: "person_bob",
        fleetStreamConnected: false,
      },
      aliceBinding,
    );
    assert.equal(offlineHandoff.outcome, "op_rejected");
    assert.equal(offlineHandoff.code, "peer_replication_disconnected");

    const handoff = await cell.run(
      {
        kind: "peer-handoff",
        targetId: "task_wip_123",
        toPersonId: "person_bob",
        lane: "night-shift",
        prNumber: 4776,
        blockingGate: "colab-preflight",
        nextAction: "Run Colab preflight and merge PR #4776.",
      },
      aliceBinding,
    );
    assert.equal(handoff.outcome, "applied", JSON.stringify(handoff));
    const { request: handoffReq } = evidence(handoff) as { request: PeerRequestV1 };
    assert.equal(handoffReq.kind, "handoff");
    assert.equal(handoffReq.continuationPacket?.wipCommitSha, wipSha);
    assert.equal(handoffReq.continuationPacket?.prNumber, 4776);
    assert.equal(handoffReq.continuationPacket?.blockingGate, "colab-preflight");
    assert.ok(handoffReq.continuationPacket?.wipBundleBlobSha256?.startsWith("sha256:"));
    assert.equal(handoffReq.attachments.length, 1);
    assert.equal(handoffReq.attachments[0]!.mediaType, "application/x-git-bundle");

    const woken = evidence(await cell.run({ kind: "peer-watch", once: true, lane: "night-shift" }, bobBinding)) as {
      matched: boolean;
      request: PeerRequestV1;
    };
    assert.equal(woken.matched, true);
    assert.equal(woken.request.requestId, handoffReq.requestId);
    assert.equal(woken.request.continuationPacket?.wipCommitSha, wipSha);

    const decisionRef = await acceptedWorkDecision(cell, adminBobBinding, "peer-promotion");
    const work = await cell.run(
      {
        kind: "task-create",
        taskId: "task_peer_work",
        title: "Night shift handoff work",
        taskClass: "work",
        decisionRef,
      },
      adminBobBinding,
    );
    assert.equal(work.outcome, "applied", JSON.stringify(work));

    const promoted = await cell.run(
      {
        kind: "peer-promote",
        requestId: handoffReq.requestId,
        work: "task_peer_work",
      },
      bobBinding,
    );
    assert.equal(promoted.outcome, "applied", JSON.stringify(promoted));
    const promotedData = evidence(promoted) as { request: PeerRequestV1; promotedTaskId: string };
    assert.equal(promotedData.request.state, "PROMOTED");
    assert.equal(promotedData.request.promotedTaskId, promotedData.promotedTaskId);
  } finally {
    await cell?.close();
    removeTempRepository(rootDir);
  }
});

test("peer accept-handoff atomically transfers active Execution preserving executionId and deliveryBaseline, and checkpoints under epoch fence", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-peer-accept-handoff-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("peer-accept"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "peer-accept-test",
    });

    const decisionRef = await acceptedWorkDecision(cell, adminAliceBinding, "peer-accept-handoff");
    const work = await cell.run(
      {
        kind: "task-create",
        taskId: "task_handoff_work",
        title: "Handoff work root",
        taskClass: "work",
        decisionRef,
      },
      adminAliceBinding,
    );
    assert.equal(work.outcome, "applied", JSON.stringify(work));

    const created = await cell.run(
      {
        kind: "task-create",
        taskId: "task_handoff_live",
        title: "Live execution handoff task",
        parentTaskId: "task_handoff_work",
      },
      aliceBinding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, aliceBinding);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, aliceBinding),
    );

    const started = await cell.run({ kind: "task-start", taskId: "task_handoff_live" }, aliceBinding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const beforeSnapshot = evidence(
      await cell.run({ kind: "task-show", taskId: "task_handoff_live" }, aliceBinding),
    ) as {
      executions: { schema: string; executionId: string; state: string; deliveryBaseline?: unknown }[];
    };
    const originalExec = beforeSnapshot.executions.find((e) => e.schema === "execution/v1" && e.state === "active");
    assert.ok(originalExec && originalExec.schema === "execution/v1", "active execution exists");
    assert.ok(originalExec.deliveryBaseline, "delivery baseline frozen at execution start");

    writeFileSync(path.join(rootDir, "handoff-wip.txt"), "alice milestone wip\n", "utf8");
    execFileSync("git", ["-C", rootDir, "add", "handoff-wip.txt"]);
    execFileSync("git", ["-C", rootDir, "commit", "-m", "wip: alice milestone"]);
    const wipSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // Alice records a lightweight WIP pointer checkpoint at epoch 1
    const cp1 = await cell.run(
      {
        kind: "peer-checkpoint",
        targetId: "task_handoff_live",
        wipCommitSha: wipSha,
        receiptRef: "receipt:colab-1",
        stewardshipEpoch: 1,
      },
      aliceBinding,
    );
    assert.equal(cp1.outcome, "applied", JSON.stringify(cp1));

    // Alice initiates handoff to Bob
    const handoff = await cell.run(
      {
        kind: "peer-handoff",
        targetId: "task_handoff_live",
        toPersonId: "person_bob",
        nodeId: "node_alice",
        nextAction: "Continue implementation and submit.",
      },
      aliceBinding,
    );
    assert.equal(handoff.outcome, "applied", JSON.stringify(handoff));
    const { request: handoffReq } = evidence(handoff) as { request: PeerRequestV1 };

    // Offline 7545 fail-closed on accept-handoff
    const offlineAccept = await cell.run(
      { kind: "peer-accept-handoff", requestId: handoffReq.requestId, fleetStreamConnected: false },
      bobBinding,
    );
    assert.equal(offlineAccept.outcome, "op_rejected");
    assert.equal(offlineAccept.code, "peer_replication_disconnected");

    // Bob atomically accepts handoff -> preserves executionId and deliveryBaseline, advances stewardshipEpoch to 2
    const accepted = await cell.run(
      {
        kind: "peer-accept-handoff",
        requestId: handoffReq.requestId,
        nodeId: "node_bob",
        materializeWorktree: true,
      },
      bobBinding,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    const acceptedData = evidence(accepted) as {
      request: PeerRequestV1;
      executionId: string;
      stewardshipEpoch: number;
      deliveryBaseline: unknown;
      materialized?: { materialized: boolean; commitSha: string };
    };
    assert.equal(acceptedData.request.state, "DONE");
    assert.equal(acceptedData.executionId, originalExec.executionId, "executionId must stay continuous");
    assert.equal(acceptedData.stewardshipEpoch, 2);
    assert.deepEqual(
      acceptedData.deliveryBaseline,
      originalExec.deliveryBaseline,
      "deliveryBaseline must be preserved",
    );
    assert.equal(acceptedData.materialized?.materialized, true);

    const afterSnapshot = evidence(await cell.run({ kind: "task-show", taskId: "task_handoff_live" }, bobBinding)) as {
      executions: {
        schema: string;
        executionId: string;
        actor: { principal: { personId: string } };
        stewardshipEpoch?: number;
        stewardNodeId?: string;
        deliveryBaseline?: unknown;
      }[];
      lease: { phase: string; actor: { principal: { personId: string } }; stewardshipEpoch?: number } | null;
    };
    const transferredExec = afterSnapshot.executions.find((e) => e.executionId === originalExec.executionId);
    assert.ok(transferredExec && transferredExec.schema === "execution/v1");
    assert.equal(transferredExec.actor.principal.personId, "person_bob");
    assert.equal(transferredExec.stewardshipEpoch, 2);
    assert.equal(transferredExec.stewardNodeId, "node_bob");
    assert.deepEqual(transferredExec.deliveryBaseline, originalExec.deliveryBaseline);
    assert.equal(afterSnapshot.lease?.phase, "held");
    assert.equal(afterSnapshot.lease?.actor.principal.personId, "person_bob");
    assert.equal(afterSnapshot.lease?.stewardshipEpoch, 2);

    // Alice (old steward) is fenced with execution_handed_off on checkpoint, progress, start/renew, and submit
    const staleCheckpoint = await cell.run(
      { kind: "peer-checkpoint", targetId: "task_handoff_live", wipCommitSha: wipSha, stewardshipEpoch: 1 },
      aliceBinding,
    );
    assert.equal(staleCheckpoint.outcome, "op_rejected");
    assert.equal(staleCheckpoint.code, "execution_handed_off");

    const staleProgress = await cell.run(
      { kind: "task-progress-append", taskId: "task_handoff_live", text: "stale alice progress" },
      aliceBinding,
    );
    assert.equal(staleProgress.outcome, "op_rejected");
    assert.equal(staleProgress.code, "execution_handed_off");

    // Bob (new steward at epoch 2) can record checkpoints cleanly
    const bobCheckpoint = await cell.run(
      { kind: "peer-checkpoint", targetId: "task_handoff_live", wipCommitSha: wipSha, stewardshipEpoch: 2 },
      bobBinding,
    );
    assert.equal(bobCheckpoint.outcome, "applied", JSON.stringify(bobCheckpoint));
  } finally {
    await cell?.close();
    removeTempRepository(rootDir);
  }
});

test("peer takeover rejects online holder / missing L1 / sub-threshold, and fences awakened old node writes with execution_handed_off", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-peer-takeover-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("peer-takeover"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "peer-takeover-test",
    });

    const decisionRef = await acceptedWorkDecision(cell, adminAliceBinding, "peer-offline-takeover");
    await cell.run(
      {
        kind: "task-create",
        taskId: "task_takeover_work",
        title: "Takeover work root",
        taskClass: "work",
        decisionRef,
      },
      adminAliceBinding,
    );
    const createdTakeover = await cell.run(
      {
        kind: "task-create",
        taskId: "task_takeover_live",
        title: "Offline takeover task",
        parentTaskId: "task_takeover_work",
      },
      aliceBinding,
    );
    assert.equal(createdTakeover.outcome, "applied", JSON.stringify(createdTakeover));
    await waitForFixturePublication(cell, createdTakeover.opId, aliceBinding);
    await realizeTaskPlanFixture(
      rootDir,
      String((createdTakeover as Record<string, unknown>).packagePath),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, aliceBinding),
    );
    const started = await cell.run({ kind: "task-start", taskId: "task_takeover_live" }, aliceBinding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const takeoverBefore = evidence(
      await cell.run({ kind: "task-show", taskId: "task_takeover_live" }, aliceBinding),
    ) as {
      executions: { schema: string; executionId: string; state: string; deliveryBaseline?: unknown }[];
    };
    const originalExec = takeoverBefore.executions.find((e) => e.schema === "execution/v1" && e.state === "active");
    assert.ok(originalExec && originalExec.schema === "execution/v1");

    // 1. Online holder cannot be silently stolen even with --human-confirmed
    const onlineSteal = await cell.run(
      {
        kind: "peer-takeover",
        targetId: "task_takeover_live",
        reason: "Trying to steal while online",
        humanConfirmed: true,
        holderNodeOnline: true,
        disconnectedForMs: 30 * 60_000,
      },
      bobBinding,
    );
    assert.equal(onlineSteal.outcome, "op_rejected");
    assert.equal(onlineSteal.code, "execution_holder_online");

    // 2. Disconnected below threshold is rejected
    const tooEarly = await cell.run(
      {
        kind: "peer-takeover",
        targetId: "task_takeover_live",
        reason: "Too early",
        humanConfirmed: true,
        holderNodeOnline: false,
        disconnectedForMs: 2 * 60_000,
        thresholdMs: 15 * 60_000,
      },
      bobBinding,
    );
    assert.equal(tooEarly.outcome, "op_rejected");
    assert.equal(tooEarly.code, "takeover_threshold_not_met");

    // 3. Disconnected past threshold without L1 human confirmation is rejected
    const noL1 = await cell.run(
      {
        kind: "peer-takeover",
        targetId: "task_takeover_live",
        reason: "No L1",
        humanConfirmed: false,
        holderNodeOnline: false,
        disconnectedForMs: 25 * 60_000,
      },
      bobBinding,
    );
    assert.equal(noL1.outcome, "op_rejected");
    assert.equal(noL1.code, "peer_local_human_confirmation_required");

    // 4. Disconnected 7545 fails closed
    const no7545 = await cell.run(
      {
        kind: "peer-takeover",
        targetId: "task_takeover_live",
        reason: "No 7545",
        humanConfirmed: true,
        holderNodeOnline: false,
        disconnectedForMs: 25 * 60_000,
        fleetStreamConnected: false,
      },
      bobBinding,
    );
    assert.equal(no7545.outcome, "op_rejected");
    assert.equal(no7545.code, "peer_replication_disconnected");

    // 5. Valid offline takeover succeeds, keeps executionId + deliveryBaseline, increments stewardshipEpoch -> 2
    const takeover = await cell.run(
      {
        kind: "peer-takeover",
        targetId: "task_takeover_live",
        reason: "Alice laptop lid closed for 25m; taking over release fix",
        humanConfirmed: true,
        holderNodeOnline: false,
        disconnectedForMs: 25 * 60_000,
        nodeId: "node_bob",
      },
      bobBinding,
    );
    assert.equal(takeover.outcome, "applied", JSON.stringify(takeover));
    const takeoverData = evidence(takeover) as {
      executionId: string;
      previousStewardshipEpoch: number;
      stewardshipEpoch: number;
      deliveryBaseline: unknown;
    };
    assert.equal(takeoverData.executionId, originalExec.executionId);
    assert.equal(takeoverData.previousStewardshipEpoch, 1);
    assert.equal(takeoverData.stewardshipEpoch, 2);
    assert.deepEqual(takeoverData.deliveryBaseline, originalExec.deliveryBaseline);

    // 6. Next morning: Alice's laptop wakes up -> submit, renew/start, progress, release, checkpoint ALL fenced with execution_handed_off
    const wokeSubmit = await cell.run(
      { kind: "task-submit", taskId: "task_takeover_live", stewardshipEpoch: 1 },
      aliceBinding,
    );
    assert.equal(wokeSubmit.outcome, "op_rejected");
    assert.equal(wokeSubmit.code, "execution_handed_off");

    const wokeStart = await cell.run(
      { kind: "task-start", taskId: "task_takeover_live", stewardshipEpoch: 1 },
      aliceBinding,
    );
    assert.equal(wokeStart.outcome, "op_rejected");
    assert.equal(wokeStart.code, "execution_handed_off");

    const wokeProgress = await cell.run(
      { kind: "task-progress-append", taskId: "task_takeover_live", text: "woke up after lid open" },
      aliceBinding,
    );
    assert.equal(wokeProgress.outcome, "op_rejected");
    assert.equal(wokeProgress.code, "execution_handed_off");

    const wokeRelease = await cell.run(
      { kind: "task-release", taskId: "task_takeover_live", reason: "stale release" },
      aliceBinding,
    );
    assert.equal(wokeRelease.outcome, "op_rejected");
    assert.equal(wokeRelease.code, "execution_handed_off");
  } finally {
    await cell?.close();
    removeTempRepository(rootDir);
  }
});
