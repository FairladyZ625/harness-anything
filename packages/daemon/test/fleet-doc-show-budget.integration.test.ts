// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { listenFleetTls } from "../src/fleet/center.ts";
import type { FleetFrameV1 } from "../src/fleet/command-protocol.ts";
import { fleetFixture, rawPeer } from "./fleet-tls-session.fixture.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "real doc-show admission shares a node budget across TLS sessions and releases after delivery",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    const release = deferred();
    const disconnectedSettled = deferred();
    t.after(release.resolve);
    const entered = [deferred(), deferred(), deferred()];
    let calls = 0;
    let failRead = false;
    const center = await fixture.hold(
      listenFleetTls({
        host: {
          ...fixture.host,
          run: async (...args: Parameters<typeof fixture.host.run>) => {
            if (args[1].kind === "doc-show" && failRead) throw new Error("injected reader failure");
            if (args[1].kind === "doc-show" && args[2]?.nodePrincipal?.nodeId === fixture.subject.nodeId) {
              entered[calls++]?.resolve();
              await release.promise;
            }
            return fixture.host.run(...args);
          },
        },
        stateRoot: fixture.stateRoot,
        ...fixture.writerOptions,
        key: fixture.key,
        cert: fixture.cert,
        authenticate: (node, secret) =>
          [fixture.subject.nodeId, fixture.peerSubject.nodeId].includes(node) && secret === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot).bind(auth),
        onError: (entry) => {
          if (entry.messageId === "first") disconnectedSettled.resolve();
        },
      }),
    );
    const peers = await Promise.all(
      Array.from({ length: 3 }, () =>
        rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
      ),
    );
    const healthy = await rawPeer(
      fixture.track,
      center.port,
      fixture.cert,
      fixture.peerSubject.nodeId,
      "machine-secret",
    );
    const metadata = await peers[0]!.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: "metadata",
      repoId: fixture.subject.repoId,
    });
    assert.equal(metadata.schema, "fleet.repo.metadata.result/v1");
    if (metadata.schema !== "fleet.repo.metadata.result/v1") throw new Error("metadata required");
    const command = (messageId: string): FleetFrameV1 => ({
      schema: "fleet.task.command/v1",
      messageId,
      opId: `op-${messageId}`,
      repoId: fixture.subject.repoId,
      taskId: fixture.subject.taskId,
      writerEpoch: metadata.writerEpoch,
      action: { kind: "doc-show", path: `${fixture.packagePath}/task_plan.md` },
      docChanges: null,
      mirrorBaseCut: null,
    });
    const first = peers[0]!.request(command("first"));
    await entered[0]!.promise;
    const second = peers[1]!.request(command("second"));
    await entered[1]!.promise;
    const third = peers[2]!.request(command("third"));
    const refused = await Promise.race([third, entered[2]!.promise.then(() => "third entered writer")]);
    assert.notEqual(
      refused,
      "third entered writer",
      "over-budget doc-show must be refused before the writer reads content",
    );
    assert.equal(typeof refused, "object");
    if (typeof refused !== "object") throw new Error("error frame expected");
    assert.equal(refused.schema, "fleet.error/v1");
    if (refused.schema !== "fleet.error/v1") throw new Error(JSON.stringify(refused));
    assert.equal(refused.code, "busy");
    assert.equal(refused.retryable, true);
    assert.match(refused.message, /node.*bulkTransfers/u);
    // Another node and the receipt control path progress while node-one's readers are parked.
    const evidence = await healthy.request(command("healthy"));
    assert.equal(evidence.schema, "fleet.task.evidence/v1");
    const completed = await healthy.receive();
    assert.equal(completed.schema, "fleet.task.result/v1");
    const control = await peers[2]!.request({
      schema: "fleet.receipt.get/v1",
      messageId: "control",
      repoId: fixture.subject.repoId,
      opId: "op-first",
    });
    assert.equal(control.schema, "fleet.receipt.result/v1");
    peers[0]!.close();
    await peers[0]!.closed;
    // A closed socket does not release a reader which is still doing work.
    assert.equal((await peers[2]!.request(command("still-running"))).schema, "fleet.error/v1");
    release.resolve();
    await disconnectedSettled.promise;
    void first; // This closed raw peer has no response waiter completion; server settlement is observed above.
    assert.equal((await second).schema, "fleet.task.evidence/v1");
    assert.equal((await peers[1]!.receive()).schema, "fleet.task.result/v1");
    // Both successful delivery and disconnected preparation release their leases.
    const again = await peers[2]!.request(command("again"));
    assert.equal(again.schema, "fleet.task.evidence/v1");
    assert.equal((await peers[2]!.receive()).schema, "fleet.task.result/v1");
    assert.equal(calls, 3);
    // Failed preparation must release too: two failures cannot consume both node slots.
    failRead = true;
    for (const id of ["failure-one", "failure-two"]) {
      const failed = await peers[2]!.request(command(id));
      assert.equal(failed.schema, "fleet.error/v1");
      if (failed.schema !== "fleet.error/v1") throw new Error(JSON.stringify(failed));
      assert.equal(failed.code, "handler_failed");
    }
    failRead = false;
    for (const id of ["missing-one", "missing-two"]) {
      const frame = command(id);
      if (frame.schema !== "fleet.task.command/v1") throw new Error("command expected");
      const missing = await peers[2]!.request({ ...frame, action: { kind: "doc-show", path: "context/missing.md" } });
      assert.equal(missing.schema, "fleet.task.result/v1");
      if (missing.schema !== "fleet.task.result/v1") throw new Error(JSON.stringify(missing));
      assert.equal(missing.outcome, "op_rejected");
    }
    assert.equal((await peers[2]!.request(command("after-failure"))).schema, "fleet.task.evidence/v1");
    assert.equal((await peers[2]!.receive()).schema, "fleet.task.result/v1");
  },
);
