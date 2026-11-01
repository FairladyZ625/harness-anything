// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { connect, type TLSSocket } from "node:tls";
import { sha256Bytes } from "@harness-anything/kernel";
import type { FleetTlsCenter } from "../src/fleet/center.ts";
import { parseFleetFrame, serializeFleetFrame, type FleetFrameV1 } from "../src/fleet/command-protocol.ts";
import { managedRbacReceiptJournal } from "../src/access-admin-state.ts";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { signInAt } from "./keycloak.fixtures.ts";
import { createNodeRetirement } from "../src/fleet/node-retirement.ts";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";

// A settled unregistration is the center cutting the node's live sessions, not a per-frame question.
// These cases cover repository metadata and the upload/ack family, plus a handshake still awaiting
// its verdict and a removal whose receipt only settles through reconcile.
async function unregisterNodeOne(
  fixture: Awaited<ReturnType<typeof fleetFixture>>,
  center: FleetTlsCenter,
  operationId: string,
): Promise<Record<string, unknown>> {
  const admin = fixture.admin(center),
    listed = (await admin.run({ operation: "node-list" })).nodes as { nodeId: string; version: string }[],
    removed = await admin.run({
      operation: "node-unregister",
      confirm: true,
      force: true,
      operationId,
      nodeId: fixture.subject.nodeId,
      expectedVersion: listed.find((node) => node.nodeId === fixture.subject.nodeId)!.version,
    });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  return removed;
}

test(
  "unregistering a node cuts its connected session while another node's frames keep being answered",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      { nodeId, repoId } = fixture.subject,
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      other = await rawPeer(fixture.track, center.port, fixture.cert, fixture.peerSubject.nodeId, "machine-secret"),
      assigned = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "metadata", repoId }),
      body = "a retired machine staged this before its removal",
      answer = (frame: FleetFrameV1) =>
        frame.schema === "fleet.error/v1"
          ? frame.code
          : frame.schema === "fleet.ack.result/v1"
            ? frame.outcome
            : frame.schema;
    assert.equal(assigned.schema, "fleet.repo.metadata.result/v1");
    if (assigned.schema !== "fleet.repo.metadata.result/v1") return;
    assert.equal(
      answer(
        await other.request({
          schema: "fleet.repo.metadata.get/v1",
          messageId: "other-metadata",
          repoId: fixture.peerSubject.repoId,
        }),
      ),
      "fleet.repo.metadata.result/v1",
    );
    // While the node is registered, repository metadata and upload/ack frames all work.
    const ready = await peer.request({
      schema: "fleet.upload.begin/v1",
      opId: "op-upload-test",
      messageId: "begin",
      repoId,
      content: {
        sha256: sha256Bytes(Buffer.from(body)),
        size: Buffer.byteLength(body),
        mediaType: "text/plain",
      },
    });
    assert.equal(ready.schema, "fleet.upload.ready/v1");
    if (ready.schema !== "fleet.upload.ready/v1") return;
    const chunked = await peer.request({
      schema: "fleet.upload.chunk/v1",
      opId: "op-upload-test",
      messageId: "chunk",
      uploadId: ready.uploadId,
      offset: 0,
      dataBase64: Buffer.from(body).toString("base64"),
    });
    assert.equal(chunked.schema, "fleet.upload.ready/v1");
    const staged = await peer.request({
      schema: "fleet.upload.finish/v1",
      opId: "op-upload-test",
      messageId: "finish",
      uploadId: ready.uploadId,
    });
    assert.equal(staged.schema, "fleet.upload.result/v1");
    // A live replication transfer is cut by the same removal; that conversation is covered by
    // fleet-replication.integration's revocation case. Here the staged upload proves the session
    // is active and answered before the cut.
    const before = fixture.eventCount();

    signInAt(fixture.userRoot, "person-admin");
    await unregisterNodeOne(fixture, center, "unregister-cut-connected");

    // The settled removal cut the session: frames buffered on it are neither processed nor answered.
    await peer.closed;
    assert.equal(fixture.eventCount(), before, "nothing was written for the unregistered node");
    // The other node's existing session is untouched and keeps answering.
    assert.equal(
      answer(
        await other.request({
          schema: "fleet.repo.metadata.get/v1",
          messageId: "other-after-cut",
          repoId: fixture.peerSubject.repoId,
        }),
      ),
      "fleet.repo.metadata.result/v1",
    );
    other.close();
  },
);

test("an unregistration that lands mid-handshake leaves no live connection behind", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    hold = fixture.holdAuthenticate(),
    socket = await new Promise<TLSSocket>((resolve, reject) => {
      const candidate = connect(
        { host: "127.0.0.1", port: center.port, ca: fixture.cert, servername: "localhost" },
        () => resolve(candidate),
      );
      candidate.once("error", reject);
    }),
    frames: FleetFrameV1[] = [];
  fixture.track(() => socket.destroy());
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("data", (chunk) => {
    let buffer = chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      frames.push(parseFleetFrame(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  socket.write(
    serializeFleetFrame({
      schema: "fleet.session.hello/v1",
      messageId: "hello",
      protocolVersion: { major: 1, minor: 0 },
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
    }),
  );
  await hold.started;
  const before = fixture.eventCount();

  signInAt(fixture.userRoot, "person-admin");
  await unregisterNodeOne(fixture, center, "unregister-mid-handshake");
  // The verdict this handshake awaited was read before the removal; it arrives late.
  hold.release(true);

  await closed;
  assert.deepEqual(
    frames.map((frame) => frame.schema),
    [],
    "no session was readied for the removed node",
  );
  assert.equal(fixture.eventCount(), before);
});

test("a removal whose receipt never settled cuts through reconcile", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    { nodeId, repoId } = fixture.subject,
    peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
    assigned = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "metadata", repoId });
  assert.equal(assigned.schema, "fleet.repo.metadata.result/v1");
  const before = fixture.eventCount();

  // The write reached the registry but the settle did not — the shape a center that died
  // between apply and settle leaves behind. The reconcile operation is the authority that
  // settles it, so that is where the cut has to come from too.
  signInAt(fixture.userRoot, "person-admin");
  const operationId = "unregister-external-write";
  // dec_F01770FD0DCF72683B7C4C7A47/CH5: removal persists a disabled device tombstone.
  const adapter = new KeycloakPolicyAdapter({
      url: fixture.owners.url,
      realm: "harness",
      resourceServerClientId: "harness-center",
    }),
    previous = (await adapter.readNode("center-token", nodeId))!;
  await adapter.deleteNode("center-token", nodeId);
  managedRbacReceiptJournal(fixture.userRoot).append(
    JSON.stringify({
      schema: "harness-access-receipt/v1",
      operationId,
      operation: "node-unregister",
      confirm: true,
      force: true,
      actor: "person-admin",
      authority: { url: "http://127.0.0.1:1", realm: "harness", clientId: "harness-center" },
      phase: "intent",
      expect: { kind: "node", nodeId, version: String(previous.revision + 1), state: "removed" },
      recordedAt: new Date().toISOString(),
    }),
  );
  const reconciled = await fixture.admin(center).run({ operation: "receipt-reconcile", operationId });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));

  await peer.closed;
  assert.equal(fixture.eventCount(), before, "nothing was written for the unregistered node");
});

test(
  "temporary center: semantic CLI preview, busy refusal, forced cut and stable reconnect rejection",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      nodeId = fixture.subject.nodeId,
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret");
    signInAt(fixture.userRoot, "person-admin");
    const admin = fixture.admin(center);
    const command = async (flags: string[]) => {
      const args = ["access", "node", "unregister", "--node-id", nodeId, ...flags],
        parsed = parseThinCommand(args, "/temporary-center");
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      if (!parsed.ok) throw new Error("CLI parse failed");
      const result = await admin.run(parsed.command.action);
      console.log(JSON.stringify({ command: `ha ${args.join(" ")}`, result }));
      return result;
    };
    const preview = await command([]);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.online, true);
    await assert.rejects(
      command(["--confirm", "--expected-version", String(preview.expectedVersion)]),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "node_busy");
        console.log(JSON.stringify({ command: "ha access node unregister --confirm", code: "node_busy" }));
        return true;
      },
    );
    assert.equal(
      (
        await peer.request({
          schema: "fleet.repo.metadata.get/v1",
          messageId: "still-alive",
          repoId: fixture.subject.repoId,
        })
      ).schema,
      "fleet.repo.metadata.result/v1",
    );
    const result = await command(["--confirm", "--force", "--expected-version", String(preview.expectedVersion)]);
    assert.equal(result.ok, true);
    await peer.closed;
    assert.deepEqual(
      center.status().replicas.filter((row) => row.nodeId === nodeId),
      [],
    );
    await assert.rejects(
      rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      (error: unknown) => {
        console.log(JSON.stringify({ reconnect: nodeId, error: String(error) }));
        return /authentication_failed/u.test(String(error));
      },
    );
  },
);

for (const operation of ["node-unregister", "device-remove"] as const) {
  test(`${operation} drains an admitted command before reporting success`, { timeout: 60_000 }, async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      { nodeId, repoId, taskId } = fixture.subject,
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      assigned = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "epoch", repoId });
    assert.equal(assigned.schema, "fleet.repo.metadata.result/v1");
    if (assigned.schema !== "fleet.repo.metadata.result/v1") return;
    const barrier = fixture.blockTaskRelease();
    t.after(barrier.release);
    const pending = peer.request({
      schema: "fleet.task.command/v1",
      messageId: "held-release",
      opId: "held-release",
      repoId,
      taskId,
      writerEpoch: assigned.writerEpoch,
      action: { kind: "task-release", taskId },
      docChanges: null,
      mirrorBaseCut: null,
    });
    await barrier.started;
    assert.equal(center.inspectNode(nodeId).inFlight, 1);
    signInAt(
      fixture.userRoot,
      operation === "device-remove" ? "person-owner" : "person-admin",
      operation === "device-remove" ? [] : ["access-admin"],
    );
    let enteredFence!: () => void,
      settled = false;
    const fenced = new Promise<void>((resolve) => {
        enteredFence = resolve;
      }),
      retirement = createNodeRetirement({
        stateRoot: fixture.stateRoot,
        center: () => center,
        repositories: () => fixture.host.status().repos,
      }),
      controlledAdmin = new AccessAdminService(createIdentitySession(fixture.userRoot), fixture.userRoot, {
        nodeRetirement: {
          ...retirement,
          fence: (id) => {
            const release = retirement.fence(id);
            enteredFence();
            return release;
          },
        },
      });
    const retiring = controlledAdmin
      .run({
        operation,
        nodeId,
        expectedVersion: "1",
        ...(operation === "node-unregister" ? { confirm: true, force: true } : {}),
      })
      .then((result) => {
        assert.equal(center.inspectNode(nodeId).inFlight, 0, "settlement requires every admitted write to finish");
        settled = true;
        return result;
      });
    assert.equal(
      await Promise.race([fenced.then(() => "fenced"), retiring.then(() => "settled")]),
      "fenced",
      "every removal entry must fence before settlement",
    );
    assert.equal(settled, false, "retirement cannot report success while an admitted write is parked");
    assert.equal(center.inspectNode(nodeId).inFlight, 1);
    // The command was admitted before the retirement fence; retirement waits for its canonical result.
    barrier.release();
    await pending;
    const result = await retiring;
    assert.equal(result.ok, true);
    assert.equal(center.inspectNode(nodeId).inFlight, 0);
    await peer.closed;
  });
}
