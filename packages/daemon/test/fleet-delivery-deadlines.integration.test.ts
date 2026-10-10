// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { TLSSocket } from "node:tls";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { FLEET_SESSION_SEND_WINDOW_BYTES, type FleetFrameV1 } from "../src/fleet/contract.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const phase of ["makeOffer", "iterator", "preparation-budget", "before-drain", "after-drain", "ACK"] as const) {
  test(`${phase} has a deadline even when the TLS session stays connected`, { timeout: 20_000 }, async (t) => {
    const f = await fleetFixture(t);
    t.after(() => f.close());
    const source = f.host.replica(f.subject.repoId);
    await source.prepare();
    const center = await f.center();
    const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
    t.after(() => t.mock.timers.reset());
    const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
    const { promise: resume, resolve: resumeRead } = Promise.withResolvers<void>();
    t.after(resumeRead);
    const blocked = new Set<TLSSocket>();
    const unblockSocket = () => {
      for (const socket of blocked) {
        Reflect.deleteProperty(socket, "writableLength");
        socket.emit("drain");
      }
    };
    t.after(unblockSocket);
    const { promise: offerHeld, resolve: markOfferHeld } = Promise.withResolvers<void>();
    const { promise: offerResume, resolve: resumeOffer } = Promise.withResolvers<void>();
    t.after(resumeOffer);
    if (phase === "preparation-budget") {
      const content = source.delivery.content;
      t.mock.method(source.delivery, "content", async (blob) => {
        markOfferHeld();
        await offerResume;
        return content(blob);
      });
    }
    if (phase === "makeOffer") {
      const content = source.delivery.content;
      t.mock.method(source.delivery, "content", async (blob) => {
        markHeld();
        await resume;
        return content(blob);
      });
    } else if (phase === "iterator" || phase === "preparation-budget") {
      const page = source.delivery.manifestPage;
      t.mock.method(source.delivery, "manifestPage", async (...args: Parameters<typeof page>) => {
        markHeld();
        await resume;
        return page(...args);
      });
    } else if (phase !== "ACK") {
      const write = TLSSocket.prototype.write;
      t.mock.method(TLSSocket.prototype, "write", function (this: TLSSocket, ...args: Parameters<typeof write>) {
        const sent = write.apply(this, args);
        if (!String(args[0]).includes('"schema":"fleet.snapshot.begin/v1"')) return sent;
        blocked.add(this);
        this.once("newListener", (event) => {
          assert.equal(event, "drain");
          markHeld();
        });
        Object.defineProperty(this, "writableLength", {
          configurable: true,
          get: () => (phase === "before-drain" ? FLEET_SESSION_SEND_WINDOW_BYTES : 1),
        });
        return phase === "before-drain";
      });
    }
    let frame = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "pull", repoId: f.subject.repoId });
    if (phase === "preparation-budget") {
      await offerHeld;
      for (let elapsed = 0; elapsed < 20_000; elapsed += 10_000) {
        t.mock.timers.tick(10_000);
        await turn();
      }
      resumeOffer();
    }
    if (phase === "ACK") {
      while (frame.schema !== "fleet.snapshot.finish/v1") {
        assert.notEqual(frame.schema, "fleet.error/v1", JSON.stringify(frame));
        frame = await peer.receive();
      }
      await turn();
    } else await held;
    const lease = center.status().replicas[0]!.deliveryLease!;
    assert.ok(lease);
    assert.equal(source.pinActive(lease), true);
    const duration =
      phase === "makeOffer"
        ? 60_000
        : phase.includes("drain")
          ? 40_000
          : 30 * 60_000 - (phase === "preparation-budget" ? 20_000 : 0);
    // Advance only after the real transport enters the targeted wait. Each renewal gets an event-loop turn.
    for (let elapsed = 0; elapsed < duration; elapsed += 10_000) {
      t.mock.timers.tick(10_000);
      await turn();
    }
    assert.equal(
      center.status().replicas[0]!.deliveryLease,
      null,
      `${phase}: the resource bound must release the lease`,
    );
    assert.equal(source.pinActive(lease), false, `${phase}: the resource bound must release the pin`);
    assert.equal(center.pendingDeliveries(), 0, `${phase}: delivery drain must settle without peer cooperation`);
    const pinActive = t.mock.method(source, "pinActive");
    t.mock.timers.tick(30 * 60_000);
    await turn();
    assert.equal(pinActive.mock.callCount(), 0, "the released delivery must stop its renewal timer");
    pinActive.mock.restore();
    unblockSocket();
    resumeRead();
    t.mock.restoreAll();
    t.mock.timers.reset();
    if (phase === "ACK") {
      let next = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "next", repoId: f.subject.repoId });
      let offer: Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" }> | undefined;
      while (next.schema !== "fleet.snapshot.finish/v1") {
        assert.notEqual(next.schema, "fleet.error/v1", JSON.stringify(next));
        if (next.schema === "fleet.snapshot.begin/v1") offer = next;
        next = await peer.receive();
      }
      assert.ok(offer, "the same open session must admit a new offer after the deadline");
      const ack = await peer.request({
        schema: "fleet.ack/v1",
        messageId: "next-ack",
        transferId: offer.transferId,
        cut: offer.cut,
        manifestDigest: offer.manifest.digest,
      });
      assert.equal(ack.schema, "fleet.ack.result/v1", JSON.stringify(ack));
      assert.equal(center.pendingDeliveries(), 0);
      return;
    }
    const next = await runFleetReplicaPullClient({
      port: center.port,
      ca: f.cert,
      credential: "machine-secret",
      repoId: f.subject.repoId,
      nodeId: f.subject.nodeId,
      viewRoot: path.join(f.root, "next"),
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    assert.equal(next.replica.schema, "fleet.ack.result/v1", "the same node's next first sync must be admitted");
    assert.equal(center.pendingDeliveries(), 0);
  });
}

test("admitted center reads may outlast the request wait budget and still reach ACK", async (t) => {
  const f = await fleetFixture(t);
  t.after(() => f.close());
  const source = f.host.replica(f.subject.repoId);
  await source.prepare();
  const center = await f.center();
  const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
  const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
  const { promise: resume, resolve: resumeRead } = Promise.withResolvers<void>();
  t.after(resumeRead);
  const page = source.delivery.manifestPage;
  t.mock.method(source.delivery, "manifestPage", async (...args: Parameters<typeof page>) => {
    markHeld();
    await resume;
    return page(...args);
  });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  t.after(() => t.mock.timers.reset());
  let frame = await peer.request({ schema: "fleet.replica.pull/v1", messageId: "pull", repoId: f.subject.repoId });
  await held;
  const lease = center.status().replicas[0]!.deliveryLease!;
  for (let elapsed = 0; elapsed < 70_000; elapsed += 10_000) {
    t.mock.timers.tick(10_000);
    await turn();
  }
  assert.equal(source.pinActive(lease), true, "the 60s admission limit does not discard admitted work");
  resumeRead();
  let offer: Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" }> | undefined;
  while (frame.schema !== "fleet.snapshot.finish/v1") {
    assert.notEqual(frame.schema, "fleet.error/v1", JSON.stringify(frame));
    if (frame.schema === "fleet.snapshot.begin/v1") offer = frame;
    frame = await peer.receive();
  }
  assert.ok(offer);
  const ack = await peer.request({
    schema: "fleet.ack/v1",
    messageId: "ack",
    transferId: offer.transferId,
    cut: offer.cut,
    manifestDigest: offer.manifest.digest,
  });
  assert.equal(ack.schema, "fleet.ack.result/v1", JSON.stringify(ack));
  assert.equal(center.pendingDeliveries(), 0);
});

for (const phase of ["before-drain", "after-drain"] as const)
  for (const progresses of [true, false])
    test(
      `${phase}: ${progresses ? "late observation of progress keeps the lease" : "idle peer fails as stalled"}`,
      { timeout: 20_000 },
      async (t) => {
        const f = await fleetFixture(t);
        t.after(() => f.close());
        const source = f.host.replica(f.subject.repoId);
        await source.prepare();
        const center = await f.center();
        const peer = await rawPeer(f.track, center.port, f.cert, f.subject.nodeId, "machine-secret");
        t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
        t.after(() => t.mock.timers.reset());
        const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
        let progressBytes = 0;
        const sockets = new Set<TLSSocket>();
        const release = () => {
          for (const socket of sockets) {
            Reflect.deleteProperty(socket, "bytesWritten");
            Reflect.deleteProperty(socket, "writableLength");
            socket.emit("drain");
          }
        };
        t.after(release);
        const write = TLSSocket.prototype.write;
        t.mock.method(TLSSocket.prototype, "write", function (this: TLSSocket, ...args: Parameters<typeof write>) {
          const sent = write.apply(this, args);
          if (!String(args[0]).includes('"schema":"fleet.snapshot.begin/v1"')) return sent;
          sockets.add(this);
          this.once("newListener", (event) => {
            assert.equal(event, "drain");
            markHeld();
          });
          const queued = phase === "before-drain" ? FLEET_SESSION_SEND_WINDOW_BYTES + 1024 : 1024;
          const written = this.bytesWritten + queued;
          Object.defineProperty(this, "bytesWritten", { configurable: true, get: () => written });
          Object.defineProperty(this, "writableLength", { configurable: true, get: () => queued - progressBytes });
          return phase === "before-drain";
        });
        let frame = await peer.request({
          schema: "fleet.replica.pull/v1",
          messageId: "pull",
          repoId: f.subject.repoId,
        });
        await held;
        progressBytes++;
        t.mock.timers.tick(10_000);
        await turn();
        const lease = center.status().replicas[0]!.deliveryLease!;
        assert.ok(lease);
        // No progress for two renewal checks. The peer advances before the next check,
        // which runs 182ms after the expiry assigned by the last progress observation.
        for (let step = 0; step < 2; step++) {
          t.mock.timers.tick(10_000);
          await turn();
        }
        t.mock.timers.tick(9_000);
        if (progresses) progressBytes++;
        t.mock.timers.tick(1_182);
        await turn();
        t.diagnostic(
          JSON.stringify({
            phase,
            progresses,
            now: Date.now(),
            originalExpiry: lease.expiresAt,
            current: center.status().replicas[0]!.deliveryLease,
          }),
        );
        if (progresses) {
          const active = center.status().replicas[0]!.deliveryLease;
          assert.ok(active, "progress before the idle limit must survive a delayed check after the old lease expiry");
          assert.equal(active.claimFence, lease.claimFence);
          assert.equal(active.holderId, lease.holderId);
          assert.equal(source.pinActive(lease), true);
        } else {
          assert.equal(center.pendingDeliveries(), 0);
          assert.equal(source.pinActive(lease), false);
          assert.equal(center.status().replicas[0]!.deliveryLease, null);
        }
        release();
        let offer: Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" }> | undefined;
        while (frame.schema !== "fleet.snapshot.finish/v1" && frame.schema !== "fleet.error/v1") {
          if (frame.schema === "fleet.snapshot.begin/v1") offer = frame;
          frame = await peer.receive();
        }
        if (!progresses) {
          assert.equal(frame.schema, "fleet.error/v1", JSON.stringify(frame));
          if (frame.schema !== "fleet.error/v1") throw new Error("expected stalled delivery");
          assert.equal(frame.code, "replica_delivery_stalled");
          assert.match(frame.message, /no transport progress.*30000 ms/i);
          return;
        }
        assert.equal(frame.schema, "fleet.snapshot.finish/v1", JSON.stringify(frame));
        assert.ok(offer);
        const ack = await peer.request({
          schema: "fleet.ack/v1",
          messageId: "ack",
          transferId: offer.transferId,
          cut: offer.cut,
          manifestDigest: offer.manifest.digest,
        });
        assert.equal(ack.schema, "fleet.ack.result/v1", JSON.stringify(ack));
        assert.equal(center.pendingDeliveries(), 0);
      },
    );
