// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetFixture, rawPeer, replicaQuota } from "./fleet-tls-session.fixture.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { saveFleetCenterConfig } from "../src/fleet-center-config.ts";
import { startDaemon, type RunningDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import type { FleetFrameV1 } from "../src/fleet/contract.ts";

for (const ending of ["ack", "disconnect", "deadline", "preparation-failure"] as const) {
  test(`build handoff drains three admitted TLS deliveries: ${ending}`, { timeout: 30_000 }, async (t) => {
    const fixture = await fleetFixture(t, undefined, "standard", false);
    const allocated = await fixture.center();
    const port = allocated.port;
    await allocated.close();
    await fixture.host.close();
    saveFleetCenterConfig(fixture.userRoot, "fleet-drain", {
      port,
      bind: "127.0.0.1",
      repoId: fixture.subject.repoId,
      keyPath: path.join(fixture.root, "tls.key"),
      certPath: fixture.certFile,
      stateRoot: fixture.stateRoot,
      quotaBytes: replicaQuota,
    });
    const runtimeFile = path.join(fixture.root, "runtime/packages/cli/dist/daemon/src/runtime.js");
    const marker = path.join(fixture.root, "runtime/packages/cli/dist/build-id.txt");
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    writeFileSync(runtimeFile, "fixture runtime\n");
    writeFileSync(marker, "build-a\n");
    const nodes = ["node-one", "node-two", "node-slow"];
    const admitted = nodes.map(() => deferred());
    const gates = nodes.map(() => deferred());
    const superseded = deferred();
    let exited = false;
    const started = await startDaemon({
      daemonId: "fleet-drain",
      userRoot: fixture.userRoot,
      runtimeFile,
      onSupersededExit: () => {
        exited = true;
        superseded.resolve();
      },
      openCell: async (input) => {
        const cell = await openBootstrappedRepoCell(input);
        return {
          ...cell,
          replica: {
            ...cell.replica,
            pin: async (...args: Parameters<typeof cell.replica.pin>) => {
              const index = nodes.indexOf(args[0].nodeId);
              admitted[index]!.resolve();
              await gates[index]!.promise;
              if (ending === "preparation-failure") throw new Error("controlled pin preparation failure");
              return cell.replica.pin(...args);
            },
          },
        };
      },
    });
    assert.ok("stop" in started);
    const daemon: RunningDaemon = started;
    t.after(async () => {
      t.mock.timers.reset();
      for (const gate of gates) gate.resolve();
      await daemon.stop();
    });
    // The saved listener opens before asynchronous repository attachments settle.
    for (;;) {
      const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status");
      if ((status.repos as { state: string }[]).every((repo) => repo.state === "attached")) break;
      await turn();
    }
    const peers = await Promise.all(
      nodes.map((node) => rawPeer(fixture.track, port, fixture.cert, node, `secret-${node}`)),
    );
    const pulling = peers.map((peer) =>
      peer.request({ schema: "fleet.replica.pull/v1", messageId: "pull", repoId: fixture.subject.repoId }),
    );
    await Promise.all(admitted.map((gate) => gate.promise));
    if (ending === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
    writeFileSync(marker, "build-b\n");
    await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000, undefined, true);
    await turn();
    assert.equal(exited, false, "a claimed delivery preparing its offer must hold the old daemon");
    const newcomer = await rawPeer(fixture.track, port, fixture.cert, "node-one", "secret-node-one");
    const rejected = await newcomer.request({
      schema: "fleet.replica.pull/v1",
      messageId: "new",
      repoId: fixture.subject.repoId,
    });
    assert.equal(rejected.schema, "fleet.error/v1");
    if (rejected.schema === "fleet.error/v1") {
      assert.equal(rejected.code, "daemon_build_draining");
      assert.equal(rejected.retryable, true);
    }
    if (ending === "deadline") {
      t.mock.timers.tick(2 * 60 * 60 * 1_000);
      await superseded.promise;
      assert.equal(exited, true, "the absolute deadline must hand off even when preparation never finishes");
      t.mock.timers.reset();
      return;
    }
    if (ending === "preparation-failure") {
      for (let i = 0; i < peers.length; i++) {
        gates[i]!.resolve();
        let result = await pulling[i]!;
        while (result.schema !== "fleet.error/v1") result = await peers[i]!.receive();
        assert.equal(result.code, "handler_failed");
        await turn();
        if (i < peers.length - 1) assert.equal(exited, false);
      }
      await superseded.promise;
      return;
    }
    const snapshots: Extract<FleetFrameV1, { schema: "fleet.snapshot.begin/v1" }>[] = [];
    for (let i = 0; i < peers.length; i++) {
      gates[i]!.resolve();
      let frame = await pulling[i]!;
      for (;;) {
        assert.notEqual(frame.schema, "fleet.error/v1", JSON.stringify(frame));
        if (frame.schema === "fleet.snapshot.begin/v1") snapshots[i] = frame;
        if (frame.schema === "fleet.snapshot.finish/v1") break;
        frame = await peers[i]!.receive();
      }
    }
    await turn();
    assert.equal(exited, false, "sending the last frame does not settle an unacknowledged delivery");
    for (let i = 0; i < peers.length; i++) {
      if (ending === "ack") {
        const snapshot = snapshots[i]!;
        const ack = await peers[i]!.request({
          schema: "fleet.ack/v1",
          messageId: `ack-${i}`,
          transferId: snapshot.transferId,
          cut: snapshot.cut,
          manifestDigest: snapshot.manifest.digest,
        });
        assert.equal(ack.schema, "fleet.ack.result/v1", JSON.stringify(ack));
      } else {
        peers[i]!.close();
        await peers[i]!.closed;
      }
      await turn();
      if (i < peers.length - 1) assert.equal(exited, false, "all nodes must settle before handoff");
    }
    await superseded.promise;
    assert.equal(exited, true);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function turn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
