// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { connect, type TLSSocket } from "node:tls";
import { sha256Bytes } from "@harness-anything/kernel";
import type { FleetTlsCenter } from "../src/fleet/center.ts";
import { parseFleetFrame, serializeFleetFrame, type FleetFrameV1 } from "../src/fleet/contract.ts";
import { managedRbacReceiptJournal } from "../src/managed-rbac-service.ts";
import { signInAt } from "./keycloak.fixtures.ts";
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
      messageId: "chunk",
      uploadId: ready.uploadId,
      offset: 0,
      dataBase64: Buffer.from(body).toString("base64"),
    });
    assert.equal(chunked.schema, "fleet.upload.ready/v1");
    const staged = await peer.request({
      schema: "fleet.upload.finish/v1",
      messageId: "finish",
      uploadId: ready.uploadId,
    });
    assert.equal(staged.schema, "fleet.upload.result/v1");
    const preparing = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "pull", repoId });
    assert.equal(preparing.schema, "fleet.replica.preparing/v1");
    const pulled = await peer.receive();
    assert.equal(pulled.schema, "fleet.snapshot.begin/v1");
    if (pulled.schema !== "fleet.snapshot.begin/v1") return;
    let frame = await peer.receive();
    while (frame.schema !== "fleet.snapshot.finish/v1") {
      assert.notEqual(frame.schema, "fleet.error/v1");
      frame = await peer.receive();
    }
    const acked = await peer.request({
      schema: "fleet.ack/v1",
      messageId: "ack",
      transferId: pulled.transferId,
      cut: pulled.cut,
      manifestDigest: frame.manifestDigest,
    });
    assert.equal(answer(acked), "applied");
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
  fixture.owners.keycloak.nodeClients.delete(`harness-node-${nodeId}`);
  managedRbacReceiptJournal(fixture.userRoot).append(
    JSON.stringify({
      schema: "harness-access-receipt/v1",
      operationId,
      operation: "node-unregister",
      actor: "person-admin",
      authority: { url: "http://127.0.0.1:1", realm: "harness", clientId: "harness-center" },
      phase: "intent",
      expect: { kind: "node", nodeId, version: "" },
      recordedAt: new Date().toISOString(),
    }),
  );
  const reconciled = await fixture.admin(center).run({ operation: "receipt-reconcile", operationId });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));

  await peer.closed;
  assert.equal(fixture.eventCount(), before, "nothing was written for the unregistered node");
});
