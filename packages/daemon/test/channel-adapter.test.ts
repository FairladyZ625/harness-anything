// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
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

test("channel adapter: webhook deliver idempotency, a2a-peer bridge, list and outbox send", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-channel-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("channel-adapter"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "channel-adapter-test",
    });

    // 1. Webhook/loopback adapter: deliver inbound message
    const webhookDeliver = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "webhook",
        envelopeId: "wh-env-1",
        principalPersonId: "person_alice",
        summary: "Feishu webhook notification",
        body: "Deployment completed",
        senderRef: "feishu-bot",
        idempotencyKey: "wh-key-1",
      },
      aliceBinding,
    );
    assert.equal(webhookDeliver.outcome, "applied", JSON.stringify(webhookDeliver));
    const whReceipt = evidence(webhookDeliver) as { receipt: { status: string; inboxItemId: string } };
    assert.equal(whReceipt.receipt.status, "accepted");
    assert.ok(whReceipt.receipt.inboxItemId);

    // 2. Idempotency: duplicate delivery returns duplicate status
    const duplicate = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "webhook",
        envelopeId: "wh-env-1-dup",
        principalPersonId: "person_alice",
        summary: "Duplicate webhook",
        idempotencyKey: "wh-key-1",
      },
      aliceBinding,
    );
    assert.equal(duplicate.outcome, "applied", JSON.stringify(duplicate));
    const dupReceipt = evidence(duplicate) as { receipt: { status: string } };
    assert.equal(dupReceipt.receipt.status, "duplicate");

    // 3. A2A peer adapter: deliver bridges to PeerRequest
    const peerDeliver = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "a2a-peer",
        envelopeId: "peer-env-1",
        principalPersonId: "person_alice",
        summary: "Cross-CEO delegation request",
        toPersonId: "person_bob",
        claim: "Need review of PR #99",
        requestedAction: "Review and approve",
        idempotencyKey: "peer-key-1",
      },
      aliceBinding,
    );
    assert.equal(peerDeliver.outcome, "applied", JSON.stringify(peerDeliver));
    const peerReceipt = evidence(peerDeliver) as {
      receipt: { status: string; peerRequestId: string };
      request: { state: string; to: { personId: string } };
    };
    assert.equal(peerReceipt.receipt.status, "routed");
    assert.ok(peerReceipt.receipt.peerRequestId);
    assert.equal(peerReceipt.request.state, "OPEN");
    assert.equal(peerReceipt.request.to.personId, "person_bob");

    // 4. Channel list: bob sees a2a-peer and webhook items
    const bobList = evidence(
      await cell.run({ kind: "channel-list", channelKind: "a2a-peer" }, bobBinding),
    ) as { items: readonly { channelKind: string; peerRequestId?: string }[] };
    assert.ok(bobList.items.length >= 1);
    assert.equal(bobList.items[0]!.channelKind, "a2a-peer");

    const aliceList = evidence(await cell.run({ kind: "channel-list" }, aliceBinding)) as {
      items: readonly { channelKind: string }[];
    };
    assert.ok(aliceList.items.length >= 1);

    // 5. Channel outbox send
    const outboxSend = await cell.run(
      {
        kind: "channel-send",
        channelKind: "gui",
        messageId: "out-1",
        recipientRef: "person_bob",
        summary: "GUI notification",
        idempotencyKey: "out-key-1",
      },
      aliceBinding,
    );
    assert.equal(outboxSend.outcome, "applied", JSON.stringify(outboxSend));
    const outReceipt = evidence(outboxSend) as { receipt: { status: string; direction: string } };
    assert.equal(outReceipt.receipt.status, "delivered");
    assert.equal(outReceipt.receipt.direction, "outbound");

    // 6. RBAC: principal mismatch fails closed
    const spoofed = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "webhook",
        envelopeId: "wh-spoof",
        principalPersonId: "person_mallory",
        summary: "Spoofed delivery",
        idempotencyKey: "wh-spoof-key",
      },
      aliceBinding,
    );
    assert.equal(spoofed.outcome, "op_rejected");
    assert.equal(spoofed.code, "peer_sender_spoofing_denied");
  } finally {
    await removeTempRepository(rootDir);
  }
});