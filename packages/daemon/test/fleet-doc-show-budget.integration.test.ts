// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listenFleetTls } from "../src/daemon-host/fleet/center.ts";
import { FLEET_FRAME_BYTES, type FleetFrameV1 } from "../src/daemon-host/fleet/command-protocol.ts";
import { fleetFixture, localAuthFixture, rawPeer } from "./fleet-tls-session.fixture.ts";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";

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
    // Repository context is readable by both nodes without borrowing node-one's task lease.
    const healthyPath = "context/healthy.md";
    const healthyBody = "# Healthy node\n";
    mkdirSync(path.join(fixture.repo, "harness/context"), { recursive: true });
    writeFileSync(path.join(fixture.repo, "harness", healthyPath), healthyBody);
    const published = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "doc-submit", paths: [healthyPath] },
      localAuthFixture(),
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));
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
    const command = (messageId: string, documentPath = `${fixture.packagePath}/task_plan.md`): FleetFrameV1 => ({
      schema: "fleet.task.command/v1",
      messageId,
      opId: `op-${messageId}`,
      repoId: fixture.subject.repoId,
      taskId: fixture.subject.taskId,
      writerEpoch: metadata.writerEpoch,
      action: { kind: "doc-show", path: documentPath },
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
    const completed = await healthy.request(command("healthy", healthyPath));
    assert.equal(completed.schema, "fleet.task.result/v1");
    if (completed.schema !== "fleet.task.result/v1") throw new Error(JSON.stringify(completed));
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal(completed.receipt?.evidence, healthyBody);
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
    assert.equal((await second).schema, "fleet.task.result/v1");
    // Both successful delivery and disconnected preparation release their leases.
    const again = await peers[2]!.request(command("again"));
    assert.equal(again.schema, "fleet.task.result/v1");
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
    assert.equal((await peers[2]!.request(command("after-failure"))).schema, "fleet.task.result/v1");
  },
);

test(
  "repo.task.read doc-show shares pre-read bulkTransfers budget with fleet.task.command and streams >96KiB concurrently without double-charging",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    const largePath = "context/large-budget-doc.md";
    const largeBody = `# Large Budget Doc\n\n${"0123456789abcdef".repeat(8 * 1024)}\n`;
    assert.ok(Buffer.byteLength(largeBody) > FLEET_FRAME_BYTES);
    mkdirSync(path.join(fixture.repo, "harness/context"), { recursive: true });
    writeFileSync(path.join(fixture.repo, "harness", largePath), largeBody);
    const published = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "doc-submit", paths: [largePath] },
      localAuthFixture(),
    );
    assert.equal(published.outcome, "applied", JSON.stringify(published));

    let holdReads = true;
    let release = deferred();
    t.after(() => release.resolve());
    let entered = [deferred(), deferred(), deferred()];
    let calls = 0;
    let failRead = false;
    const center = await fixture.hold(
      listenFleetTls({
        host: {
          ...fixture.host,
          run: async (...args: Parameters<typeof fixture.host.run>) => {
            if (args[1].kind === "doc-show" && failRead) throw new Error("injected operational read failure");
            if (args[1].kind === "doc-show" && holdReads && args[2]?.nodePrincipal?.nodeId === fixture.subject.nodeId) {
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
        authenticate: (node, secret) => node === fixture.subject.nodeId && secret === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot).bind(auth),
      }),
    );
    const peers = await Promise.all(
      Array.from({ length: 3 }, () =>
        rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
      ),
    );
    const metadata = await peers[0]!.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: "metadata",
      repoId: fixture.subject.repoId,
    });
    assert.equal(metadata.schema, "fleet.repo.metadata.result/v1");
    if (metadata.schema !== "fleet.repo.metadata.result/v1") throw new Error("metadata required");

    const taskCmdDocShow = (messageId: string, documentPath = largePath): FleetFrameV1 => ({
      schema: "fleet.task.command/v1",
      messageId,
      opId: `op-${messageId}`,
      repoId: fixture.subject.repoId,
      taskId: fixture.subject.taskId,
      writerEpoch: metadata.writerEpoch,
      action: { kind: "doc-show", path: documentPath },
      docChanges: null,
      mirrorBaseCut: null,
    });
    const opReadDocShow = (messageId: string, documentPath = largePath): FleetFrameV1 => ({
      schema: "fleet.operational.read/v1",
      messageId,
      repoId: fixture.subject.repoId,
      method: "repo.task.read",
      payload: { action: { kind: "doc-show", path: documentPath } },
    });

    // Mixed ingress across connections: 1 via fleet.task.command/v1 + 1 via fleet.operational.read/v1 (repo.task.read).
    const first = peers[0]!.request(taskCmdDocShow("mixed-1"));
    await entered[0]!.promise;
    const second = peers[1]!.request(opReadDocShow("mixed-2"));
    await entered[1]!.promise;

    // 3rd request over repo.task.read must be refused with busy BEFORE reading document body.
    const thirdOpRead = await Promise.race([
      peers[2]!.request(opReadDocShow("mixed-3-op")),
      entered[2]!.promise.then(() => "third entered writer" as const),
    ]);
    assert.notEqual(thirdOpRead, "third entered writer");
    assert.equal(typeof thirdOpRead, "object");
    if (typeof thirdOpRead !== "object") throw new Error("error frame expected");
    assert.equal(thirdOpRead.schema, "fleet.error/v1");
    if (thirdOpRead.schema !== "fleet.error/v1") throw new Error(JSON.stringify(thirdOpRead));
    assert.equal(thirdOpRead.code, "busy");
    assert.equal(thirdOpRead.retryable, true);
    assert.match(thirdOpRead.message, /node.*bulkTransfers/u);

    // Release both >96 KiB readers simultaneously: both must complete chunked transfer without double-charging bulkTransfers.
    release.resolve();
    const [firstReply, secondReply] = await Promise.all([first, second]);
    assert.equal(firstReply.schema, "fleet.task.result/v1");
    if (firstReply.schema !== "fleet.task.result/v1") throw new Error(JSON.stringify(firstReply));
    assert.equal(firstReply.receipt?.evidence, largeBody);
    assert.equal(secondReply.schema, "fleet.operational.read.result/v1");
    if (secondReply.schema !== "fleet.operational.read.result/v1") throw new Error(JSON.stringify(secondReply));
    assert.equal(secondReply.result.evidence, largeBody);
    assert.equal(calls, 2);

    // Reverse mixed ingress: 2 slots held via repo.task.read -> 3rd via fleet.task.command/v1 is refused with busy.
    release = deferred();
    entered = [deferred(), deferred(), deferred()];
    calls = 0;
    const op1 = peers[0]!.request(opReadDocShow("op-1"));
    await entered[0]!.promise;
    const op2 = peers[1]!.request(opReadDocShow("op-2"));
    await entered[1]!.promise;
    const thirdCmd = await Promise.race([
      peers[2]!.request(taskCmdDocShow("op-3-cmd")),
      entered[2]!.promise.then(() => "third entered writer" as const),
    ]);
    assert.notEqual(thirdCmd, "third entered writer");
    assert.equal(typeof thirdCmd, "object");
    if (typeof thirdCmd !== "object") throw new Error("error frame expected");
    assert.equal(thirdCmd.schema, "fleet.error/v1");
    if (thirdCmd.schema !== "fleet.error/v1") throw new Error(JSON.stringify(thirdCmd));
    assert.equal(thirdCmd.code, "busy");
    assert.equal(thirdCmd.retryable, true);
    release.resolve();
    const [op1Reply, op2Reply] = await Promise.all([op1, op2]);
    assert.equal(op1Reply.schema, "fleet.operational.read.result/v1");
    assert.equal(op2Reply.schema, "fleet.operational.read.result/v1");
    if (op1Reply.schema === "fleet.operational.read.result/v1") assert.equal(op1Reply.result.evidence, largeBody);
    if (op2Reply.schema === "fleet.operational.read.result/v1") assert.equal(op2Reply.result.evidence, largeBody);

    // Failed repo.task.read doc-show must release its reservation too.
    holdReads = false;
    failRead = true;
    for (const id of ["op-fail-1", "op-fail-2"]) {
      const failed = await peers[2]!.request(opReadDocShow(id));
      assert.equal(failed.schema, "fleet.error/v1");
      if (failed.schema !== "fleet.error/v1") throw new Error(JSON.stringify(failed));
      assert.equal(failed.code, "handler_failed");
    }
    failRead = false;
    const afterFailure = await peers[2]!.request(opReadDocShow("op-after-failure"));
    assert.equal(afterFailure.schema, "fleet.operational.read.result/v1");
    if (afterFailure.schema === "fleet.operational.read.result/v1")
      assert.equal(afterFailure.result.evidence, largeBody);
  },
);
