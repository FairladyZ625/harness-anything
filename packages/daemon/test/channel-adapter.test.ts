// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteEventStore } from "@harness-anything/storage";
import { registerChannelOutboundAdapter } from "../src/daemon-host/channel-outbox.ts";
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
    assertPersistedBody(rootDir, "channel-adapter", "Deployment completed", webhookDeliver.opId);

    const guiDeliver = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "gui",
        envelopeId: "gui-env-1",
        principalPersonId: "person_alice",
        summary: "Interactive GUI message",
        idempotencyKey: "gui-key-1",
      },
      aliceBinding,
    );
    assert.equal(guiDeliver.outcome, "applied", JSON.stringify(guiDeliver));
    assert.equal((evidence(guiDeliver) as { receipt: { status: string } }).receipt.status, "accepted");

    // 2. Idempotency: duplicate delivery from the same sender returns duplicate status
    const duplicate = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "webhook",
        envelopeId: "wh-env-1-dup",
        principalPersonId: "person_alice",
        summary: "Duplicate webhook",
        senderRef: "feishu-bot",
        idempotencyKey: "wh-key-1",
      },
      aliceBinding,
    );
    assert.equal(duplicate.outcome, "no_changes", JSON.stringify(duplicate));
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

    const repeatedPeerDeliver = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "a2a-peer",
        envelopeId: "peer-env-1-retry",
        principalPersonId: "person_alice",
        summary: "Retry of the same request",
        toPersonId: "person_bob",
        claim: "Need review of PR #99",
        requestedAction: "Review and approve",
        idempotencyKey: "peer-key-1",
      },
      aliceBinding,
    );
    const repeatedPeerReceipt = evidence(repeatedPeerDeliver) as {
      receipt: { status: string; peerRequestId?: string };
    };
    assert.equal(repeatedPeerReceipt.receipt.status, "duplicate");
    assert.equal(repeatedPeerReceipt.receipt.peerRequestId, peerReceipt.receipt.peerRequestId);

    // 4. Channel list: bob sees a2a-peer and webhook items
    const bobList = evidence(await cell.run({ kind: "channel-list", channelKind: "a2a-peer" }, bobBinding)) as {
      items: readonly { channelKind: string; peerRequestId?: string }[];
    };
    assert.ok(bobList.items.length >= 1);
    assert.equal(bobList.items[0]!.channelKind, "a2a-peer");

    const aliceList = evidence(await cell.run({ kind: "channel-list" }, aliceBinding)) as {
      items: readonly { channelKind: string }[];
    };
    assert.ok(aliceList.items.length >= 1);
    assert.ok(aliceList.items.some((item) => item.channelKind === "gui"));

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
    assert.ok((outReceipt.receipt as { inboxItemId?: string }).inboxItemId);

    const bobChannels = evidence(await cell.run({ kind: "channel-list" }, bobBinding)) as {
      items: readonly { channelKind: string; direction: string; summary: string }[];
    };
    assert.ok(
      bobChannels.items.some(
        (item) => item.channelKind === "gui" && item.direction === "inbound" && item.summary === "GUI notification",
      ),
    );

    const repeatedSend = await cell.run(
      {
        kind: "channel-send",
        channelKind: "gui",
        messageId: "out-1-retry",
        recipientRef: "person_bob",
        summary: "Retry should not enqueue again",
        idempotencyKey: "out-key-1",
      },
      aliceBinding,
    );
    assert.equal(repeatedSend.outcome, "no_changes", JSON.stringify(repeatedSend));
    assert.equal((evidence(repeatedSend) as { receipt: { status: string } }).receipt.status, "duplicate");

    const sameKeyDifferentDirection = await cell.run(
      {
        kind: "channel-deliver",
        channelKind: "gui",
        envelopeId: "gui-in-out-key",
        principalPersonId: "person_alice",
        summary: "Inbound using the outbound key",
        idempotencyKey: "out-key-1",
      },
      aliceBinding,
    );
    assert.equal(sameKeyDifferentDirection.outcome, "applied", JSON.stringify(sameKeyDifferentDirection));
    assert.equal((evidence(sameKeyDifferentDirection) as { receipt: { status: string } }).receipt.status, "accepted");

    const loopback = await cell.run(
      {
        kind: "channel-send",
        channelKind: "webhook",
        route: "local-loopback",
        messageId: "loop-1",
        recipientRef: "person_bob",
        summary: "Webhook loopback notification",
        body: "Loopback body survives restart",
        idempotencyKey: "loop-key-1",
      },
      aliceBinding,
    );
    assert.equal(loopback.outcome, "applied", JSON.stringify(loopback));
    const bobAfterLoopback = evidence(await cell.run({ kind: "channel-list", channelKind: "webhook" }, bobBinding)) as {
      items: readonly { summary: string; status: string }[];
    };
    assert.ok(bobAfterLoopback.items.some((item) => item.summary === "Webhook loopback notification"));
    assertPersistedBody(rootDir, "channel-adapter", "Loopback body survives restart", loopback.opId);

    const sameKeyDifferentSender = await cell.run(
      {
        kind: "channel-send",
        channelKind: "webhook",
        route: "local-loopback",
        messageId: "loop-2",
        recipientRef: "person_alice",
        summary: "Independent sender message",
        idempotencyKey: "loop-key-1",
      },
      bobBinding,
    );
    assert.equal(sameKeyDifferentSender.outcome, "applied", JSON.stringify(sameKeyDifferentSender));

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

    // 7. F-03: bidirectional list, filter-before-pagination, cursor pagination, and invalid cursor fail-closed
    const aliceOutboundPage1 = evidence(
      await cell.run({ kind: "channel-list", direction: "outbound", limit: 1 }, aliceBinding),
    ) as {
      items: readonly { itemId: string; direction: string; channelKind: string }[];
      nextCursor: string | null;
    };
    assert.equal(aliceOutboundPage1.items.length, 1);
    assert.equal(aliceOutboundPage1.items[0]!.direction, "outbound");
    assert.ok(aliceOutboundPage1.nextCursor, "expected nextCursor when more outbound items exist");

    const collectedOutboundIds = [aliceOutboundPage1.items[0]!.itemId];
    let cursor: string | null = aliceOutboundPage1.nextCursor;
    while (cursor !== null) {
      const nextPage = evidence(
        await cell.run({ kind: "channel-list", direction: "outbound", limit: 1, cursor }, aliceBinding),
      ) as {
        items: readonly { itemId: string; direction: string; channelKind: string }[];
        nextCursor: string | null;
      };
      for (const entry of nextPage.items) {
        assert.equal(entry.direction, "outbound");
        collectedOutboundIds.push(entry.itemId);
      }
      cursor = nextPage.nextCursor;
    }
    assert.equal(new Set(collectedOutboundIds).size, collectedOutboundIds.length, "cursor pages must not duplicate");
    assert.ok(collectedOutboundIds.length >= 3, "alice should see gui, webhook, and a2a-peer outbound items");

    const filteredWebhookBeforeLimit = evidence(
      await cell.run({ kind: "channel-list", channelKind: "webhook", direction: "outbound", limit: 1 }, aliceBinding),
    ) as {
      items: readonly { channelKind: string; direction: string; summary: string }[];
    };
    assert.equal(filteredWebhookBeforeLimit.items.length, 1);
    assert.equal(filteredWebhookBeforeLimit.items[0]!.channelKind, "webhook");
    assert.equal(filteredWebhookBeforeLimit.items[0]!.direction, "outbound");

    const badCursor = await cell.run({ kind: "channel-list", cursor: "bad-cursor" }, aliceBinding);
    assert.equal(badCursor.outcome, "op_rejected");
    assert.equal(badCursor.code, "invalid_field");
  } finally {
    await cell?.close();
    await removeTempRepository(rootDir);
  }
});

test("channel outbox: G3 durable routing, transient retry across daemon restart, terminal failure, and a2a-peer send", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-channel-outbox-"));
  const repoId = workspaceId("channel-outbox-replay");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  let clockMs = Date.parse("2026-11-25T10:00:00.000Z");
  const seenDeliveries: { messageId: string; body?: string; attempt: number }[] = [];
  let attemptCount = 0;

  const unregister = registerChannelOutboundAdapter(repoId, {
    id: "test:lark-retry",
    channelKind: "lark",
    matches: (message) => message.route === "feishu-bot",
    deliver: (message) => {
      attemptCount += 1;
      seenDeliveries.push({ messageId: message.messageId, body: message.body, attempt: attemptCount });
      if (message.recipientRef === "chat_fail") return { status: "failed", reasonCode: "invalid_lark_chat" };
      if (attemptCount === 1) return { status: "pending_retry", reasonCode: "upstream_503" };
      return { status: "delivered", recipientInboxItemId: `lark-ext-${message.messageId}` };
    },
  });

  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "channel-outbox-test-1",
      now: () => new Date(clockMs).toISOString(),
    });

    // Unregistered route fails closed
    const unregistered = await cell.run(
      {
        kind: "channel-send",
        channelKind: "custom",
        route: "missing-route",
        recipientRef: "person_bob",
        summary: "No adapter",
      },
      aliceBinding,
    );
    assert.equal(unregistered.outcome, "op_rejected");
    assert.equal(unregistered.code, "unsupported_command");

    // Attempt 1 through registered external lark adapter -> transient failure -> durable pending_retry
    const firstSend = await cell.run(
      {
        kind: "channel-send",
        channelKind: "lark",
        route: "feishu-bot",
        messageId: "lark-msg-1",
        recipientRef: "chat_ops",
        summary: "Release alert",
        body: "Persisted across restart",
        idempotencyKey: "lark-key-1",
      },
      aliceBinding,
    );
    assert.equal(firstSend.outcome, "applied", JSON.stringify(firstSend));
    const firstReceipt = evidence(firstSend) as { receipt: { status: string; reasonCode?: string } };
    assert.equal(firstReceipt.receipt.status, "pending_retry");
    assert.equal(firstReceipt.receipt.reasonCode, "upstream_503");

    const outboundBeforeRestart = evidence(
      await cell.run({ kind: "channel-list", channelKind: "lark", direction: "outbound" }, aliceBinding),
    ) as { items: readonly { status: string; summary: string }[] };
    assert.equal(outboundBeforeRestart.items.length, 1);
    assert.equal(outboundBeforeRestart.items[0]!.status, "pending_retry");

    // Simulate daemon restart and advance clock past retry lease
    await cell.close();
    cell = undefined;
    clockMs += 5_000;
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "channel-outbox-test-2",
      now: () => new Date(clockMs).toISOString(),
    });

    // Replay after restart reconstructs body from canonical storage and delivers durably
    const replayedSend = await cell.run(
      {
        kind: "channel-send",
        channelKind: "lark",
        route: "feishu-bot",
        messageId: "lark-msg-1",
        recipientRef: "chat_ops",
        summary: "Release alert",
        body: "Persisted across restart",
        idempotencyKey: "lark-key-1",
      },
      aliceBinding,
    );
    assert.equal(replayedSend.outcome, "applied", JSON.stringify(replayedSend));
    const replayedReceipt = evidence(replayedSend) as { receipt: { status: string; inboxItemId?: string } };
    assert.equal(replayedReceipt.receipt.status, "delivered");
    assert.equal(replayedReceipt.receipt.inboxItemId, "lark-ext-lark-msg-1");
    assert.equal(seenDeliveries.length, 2);
    assert.equal(seenDeliveries[1]!.body, "Persisted across restart");

    const outboundAfterReplay = evidence(
      await cell.run({ kind: "channel-list", channelKind: "lark", direction: "outbound" }, aliceBinding),
    ) as { items: readonly { status: string; summary: string }[] };
    assert.equal(outboundAfterReplay.items.length, 1);
    assert.equal(outboundAfterReplay.items[0]!.status, "delivered");

    // Once delivered, a third send is idempotently deduplicated without calling the adapter again
    const thirdSend = await cell.run(
      {
        kind: "channel-send",
        channelKind: "lark",
        route: "feishu-bot",
        messageId: "lark-msg-1",
        recipientRef: "chat_ops",
        summary: "Release alert",
        idempotencyKey: "lark-key-1",
      },
      aliceBinding,
    );
    assert.equal(thirdSend.outcome, "no_changes", JSON.stringify(thirdSend));
    assert.equal(seenDeliveries.length, 2);

    // Terminal failure is durably recorded as failed
    const terminalFail = await cell.run(
      {
        kind: "channel-send",
        channelKind: "lark",
        route: "feishu-bot",
        messageId: "lark-msg-fail",
        recipientRef: "chat_fail",
        summary: "Invalid destination",
        idempotencyKey: "lark-key-fail",
      },
      aliceBinding,
    );
    assert.equal(terminalFail.outcome, "applied", JSON.stringify(terminalFail));
    const failReceipt = evidence(terminalFail) as { receipt: { status: string; reasonCode?: string } };
    assert.equal(failReceipt.receipt.status, "failed");
    assert.equal(failReceipt.receipt.reasonCode, "invalid_lark_chat");

    // Built-in a2a-peer outbound adapter routes to PeerRequest + recipient inbox
    const peerOutbound = await cell.run(
      {
        kind: "channel-send",
        channelKind: "a2a-peer",
        messageId: "peer-out-1",
        recipientRef: "person_bob",
        summary: "Outbound peer check",
        body: "Please verify staging logs",
        idempotencyKey: "peer-out-key-1",
      },
      aliceBinding,
    );
    assert.equal(peerOutbound.outcome, "applied", JSON.stringify(peerOutbound));
    const peerOutReceipt = evidence(peerOutbound) as { receipt: { status: string; peerRequestId?: string } };
    assert.equal(peerOutReceipt.receipt.status, "routed");
    assert.ok(peerOutReceipt.receipt.peerRequestId);
  } finally {
    unregister();
    await cell?.close();
    await removeTempRepository(rootDir);
  }
});

function assertPersistedBody(rootDir: string, repoId: string, body: string, opId: string): void {
  const sha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const store = openSqliteEventStore({ repoId: workspaceId(repoId), rootInput: rootDir, readOnly: true });
  try {
    assert.equal(Buffer.from(store.readContentObject(sha256) ?? []).toString("utf8"), body);
    const event = store.event(opId);
    assert.ok(event && event.type === "inbox_item_enqueued");
    if (!event || event.type !== "inbox_item_enqueued") throw new Error("Expected persisted inbox enqueue event.");
    assert.equal(event.payload.bodyContentClaim?.sha256, sha256);
  } finally {
    store.close();
  }
}
