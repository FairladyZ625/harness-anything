// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { openBootstrappedRepoCell as openRepoCell } from "../../daemon/test/repo-settings.fixture.ts";
import { evidence, initRepo } from "../../daemon/test/task-surface.fixtures.ts";
import { withPolicyGroup } from "../../daemon/test/keycloak-policy.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("channel deliver and send expose their required CLI input facets", () => {
  const deliver = parseThinCommand([
    "channel",
    "deliver",
    "--channel",
    "webhook",
    "--principal",
    "person_alice",
    "--summary",
    "Deployment complete",
    "--body",
    "Build 42 passed",
    "--idempotency-key",
    "delivery-42",
  ]);
  assert.equal(deliver.ok, true, JSON.stringify(deliver));
  if (deliver.ok) {
    assert.equal(deliver.command.action.kind, "channel-deliver");
    assert.equal(deliver.command.action.channelKind, "webhook");
    assert.equal(deliver.command.action.body, "Build 42 passed");
  }

  const send = parseThinCommand([
    "channel",
    "send",
    "--channel",
    "webhook",
    "--to",
    "person_bob",
    "--summary",
    "Deployment complete",
    "--route",
    "local-loopback",
  ]);
  assert.equal(send.ok, true, JSON.stringify(send));
  if (send.ok) {
    assert.equal(send.command.action.kind, "channel-send");
    assert.equal(send.command.action.recipientRef, "person_bob");
    assert.equal(send.command.action.route, "local-loopback");
  }

  const list = parseThinCommand([
    "channel",
    "list",
    "--channel",
    "webhook",
    "--direction",
    "outbound",
    "--limit",
    "5",
    "--cursor",
    "inbox:0",
  ]);
  assert.equal(list.ok, true, JSON.stringify(list));
  if (list.ok) {
    assert.equal(list.command.action.kind, "channel-list");
    assert.equal(list.command.action.channelKind, "webhook");
    assert.equal(list.command.action.direction, "outbound");
    assert.equal(list.command.action.limit, 5);
    assert.equal(list.command.action.cursor, "inbox:0");
  }
});

test("channel deliver and send parsed from CLI execute authorized daemon writes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-channel-"));
  const aliceBinding = withPolicyGroup(
    { actor: { principal: { personId: "person_alice" }, executor: null }, source: "local" as const },
    "contributor",
  );
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("cli-channel-e2e"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "cli-channel-test",
    });

    const deliver = parseThinCommand([
      "channel",
      "deliver",
      "--channel",
      "gui",
      "--principal",
      "person_alice",
      "--summary",
      "CLI delivered item",
      "--body",
      "CLI body persisted",
      "--idempotency-key",
      "cli-deliver-e2e-1",
    ]);
    assert.equal(deliver.ok, true, JSON.stringify(deliver));
    if (deliver.ok) {
      const receipt = await cell.run(deliver.command.action, aliceBinding);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const payload = evidence(receipt) as { receipt: { status: string; bodyBlobSha256?: string } };
      assert.equal(payload.receipt.status, "accepted");
      assert.ok(payload.receipt.bodyBlobSha256);
    }

    const send = parseThinCommand([
      "channel",
      "send",
      "--channel",
      "webhook",
      "--to",
      "person_bob",
      "--summary",
      "CLI outbound webhook",
      "--body",
      "CLI outbound body",
      "--route",
      "local-loopback",
      "--idempotency-key",
      "cli-send-e2e-1",
    ]);
    assert.equal(send.ok, true, JSON.stringify(send));
    if (send.ok) {
      const receipt = await cell.run(send.command.action, aliceBinding);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const payload = evidence(receipt) as { receipt: { status: string; direction: string } };
      assert.equal(payload.receipt.status, "delivered");
      assert.equal(payload.receipt.direction, "outbound");
    }
  } finally {
    await cell?.close();
    await removeTempRepository(rootDir);
  }
});
