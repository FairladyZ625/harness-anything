// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { acceptedWorkDecision, openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { evidence, initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const aliceBinding = withPolicyGroup(
  { actor: { principal: { personId: "person_alice" }, executor: null }, source: "local" as const },
  "contributor",
);
const bobBinding = withPolicyGroup(
  { actor: { principal: { personId: "person_bob" }, executor: null }, source: "local" as const },
  "contributor",
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
