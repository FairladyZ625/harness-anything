// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { FLEET_SESSION_SEND_WINDOW_BYTES, parseFleetFrame, type FleetFrameV1 } from "../src/fleet/contract.ts";

// Exercise the actual TLS sender's two drain awaits with a controlled writable buffer.
// The first begin is transmitted normally; no drain is emitted until the test releases it.
test(
  "two backpressured first syncs and a pending ACK retain independent leases past the TTL",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    await f.host.replica(f.subject.repoId).prepare();
    const center = await f.center();
    const blocked = new Map<string, TLSSocket>();
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    const release = () => {
      for (const socket of blocked.values()) {
        Reflect.deleteProperty(socket, "writableLength");
        socket.emit("drain");
      }
    };
    t.after(release);
    const write = TLSSocket.prototype.write;
    t.mock.method(TLSSocket.prototype, "write", function (this: TLSSocket, ...args: Parameters<typeof write>) {
      const sent = write.apply(this, args);
      const line = String(args[0]);
      if (!line.includes('"schema":"fleet.snapshot.begin/v1"')) return sent;
      const frame = parseFleetFrame(line.trim());
      if (frame.schema !== "fleet.snapshot.begin/v1" || frame.viewId === f.slowSubject.nodeId) return sent;
      assert.equal(sent, true, "the fixture begins below native backpressure");
      this.once("newListener", (event) => {
        assert.equal(event, "drain");
        blocked.set(frame.viewId, this);
        if (blocked.size === 2) markWaiting();
      });
      if (frame.viewId === f.subject.nodeId) return false;
      Object.defineProperty(this, "writableLength", { configurable: true, get: () => FLEET_SESSION_SEND_WINDOW_BYTES });
      return true;
    });
    const options = {
      port: center.port,
      ca: f.cert,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      diskQuotaBytes: 64 * 1024 * 1024,
      timeoutMs: 55_000,
    };
    const pulls = [f.subject, f.peerSubject].map(({ nodeId }) =>
      runFleetReplicaPullClient({ ...options, nodeId, viewRoot: path.join(f.root, nodeId) }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
    const peer = await rawPeer(f.track, center.port, f.cert, f.slowSubject.nodeId, "machine-secret");
    let frame = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "pull", repoId: f.subject.repoId });
    let snapshot: Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" }> | undefined;
    for (;;) {
      assert.notEqual(frame.schema, "fleet.error/v1", JSON.stringify(frame));
      if (frame.schema === "fleet.snapshot.begin/v1") snapshot = frame;
      if (frame.schema === "fleet.snapshot.finish/v1") break;
      frame = await peer.receive();
    }
    assert.ok(snapshot);
    await waiting;
    const initial = center.status().replicas.map((row) => row.deliveryLease!);
    assert.equal(initial.length, 3);
    assert.equal(center.pendingDeliveries(), 3);
    await delay(Math.max(...initial.map((lease) => lease.expiresAt)) - Date.now() + 100);
    for (const lease of initial) {
      const renewed = center.status().replicas.find((row) => row.nodeId === lease.nodeId)!.deliveryLease;
      t.diagnostic(
        JSON.stringify({ phase: lease.nodeId === f.slowSubject.nodeId ? "ACK" : "drain", initial: lease, renewed }),
      );
      assert.ok(renewed, "a connected delivery waiting on drain or ACK must not expire");
      assert.equal(renewed.holderId, lease.holderId);
      assert.equal(renewed.claimFence, lease.claimFence);
      assert.ok(renewed.expiresAt > lease.expiresAt);
    }
    const ack = await peer.request({
      schema: "fleet.ack/v1",
      messageId: "ack",
      transferId: snapshot.transferId,
      cut: snapshot.cut,
      manifestDigest: snapshot.manifest.digest,
    });
    assert.equal(ack.schema, "fleet.ack.result/v1", JSON.stringify(ack));
    release();
    for (const pending of pulls) {
      const result = await pending;
      if ("error" in result) throw result.error;
      assert.equal(result.value.replica.schema, "fleet.ack.result/v1");
    }
    assert.equal(center.pendingDeliveries(), 0);
    assert.ok(center.status().replicas.every((row) => row.deliveryLease === null));
  },
);

for (const ending of ["ack", "rejected-ack", "disconnect"] as const) {
  test(`${ending} ends renewal even if the session would otherwise remain open`, { timeout: 15_000 }, async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    await source.prepare();
    const center = await f.center();
    t.mock.timers.enable({ apis: ["setInterval"] });
    t.after(() => t.mock.timers.reset());
    const { promise: released, resolve: markReleased } = Promise.withResolvers<void>();
    const releasePin = source.releasePin;
    t.mock.method(source, "releasePin", (lease) => {
      releasePin(lease);
      markReleased();
    });
    const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
    let frame = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "pull", repoId: f.subject.repoId });
    let snapshot: Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" }> | undefined;
    for (;;) {
      assert.notEqual(frame.schema, "fleet.error/v1", JSON.stringify(frame));
      if (frame.schema === "fleet.snapshot.begin/v1") snapshot = frame;
      if (frame.schema === "fleet.snapshot.finish/v1") break;
      frame = await peer.receive();
    }
    assert.ok(snapshot);
    if (ending === "disconnect") {
      peer.close();
      await released;
    } else {
      const result = await peer.request({
        schema: "fleet.ack/v1",
        messageId: "ack",
        transferId: snapshot.transferId,
        cut: snapshot.cut,
        manifestDigest: ending === "ack" ? snapshot.manifest.digest : "f".repeat(64),
      });
      assert.equal(result.schema, ending === "ack" ? "fleet.ack.result/v1" : "fleet.error/v1", JSON.stringify(result));
      if (result.schema === "fleet.error/v1") assert.equal(result.code, "invalid_ack");
    }
    assert.equal(center.pendingDeliveries(), 0);
    assert.equal(center.status().replicas[0]!.deliveryLease, null);
    const pinActive = t.mock.method(source, "pinActive");
    t.mock.timers.tick(60_000);
    assert.equal(pinActive.mock.callCount(), 0, "released work must not be revisited by renewal");
    await center.close();
    t.mock.timers.tick(60_000);
  });
}

test(
  "renewal failure during a held read preserves the fence error and cannot release a successor",
  { timeout: 15_000 },
  async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    await source.prepare();
    const center = await f.center();
    t.mock.timers.enable({ apis: ["setInterval"] });
    t.after(() => t.mock.timers.reset());
    const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
    const { promise: resume, resolve: releaseRead } = Promise.withResolvers<void>();
    t.after(releaseRead);
    const content = source.delivery.content;
    t.mock.method(source.delivery, "content", async (blob) => {
      markHeld();
      await resume;
      return content(blob);
    });
    const pending = assert.rejects(
      runFleetReplicaPullClient({
        port: center.port,
        ca: f.cert,
        credential: "machine-secret",
        repoId: f.subject.repoId,
        nodeId: f.subject.nodeId,
        viewRoot: path.join(f.root, "fenced"),
        diskQuotaBytes: 64 * 1024 * 1024,
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "replica_delivery_fenced");
        const detail = JSON.parse(error.message.split(" diagnostics=")[1]!);
        assert.equal(detail.branch, "lease_renewal_failed");
        assert.equal(detail.lease.state, "replaced");
        assert.equal(detail.lease.current.holderId, "successor");
        return true;
      },
    );
    await held;
    const previous = center.status().replicas[0]!.deliveryLease!;
    const leases = openReplicaAckStore(f.stateRoot);
    t.after(() => leases.close());
    leases.delivery.release(previous);
    const successor = leases.delivery.claim(previous, "successor", Date.now(), 30_000)!;
    assert.ok(successor);
    t.mock.timers.tick(10_000);
    assert.deepEqual(leases.delivery.active(previous, Date.now()), successor);
    releaseRead();
    await pending;
    assert.equal(center.pendingDeliveries(), 0);
    assert.deepEqual(leases.delivery.active(previous, Date.now()), successor);
    const pinActive = t.mock.method(source, "pinActive");
    t.mock.timers.tick(60_000);
    assert.equal(pinActive.mock.callCount(), 0);
  },
);
