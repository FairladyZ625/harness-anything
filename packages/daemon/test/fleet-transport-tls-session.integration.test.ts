// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fleetHostWriterOptions, fleetLedgerRevision, waitForFleetPublication } from "./fleet-store.fixture.ts";
import { setTimeout as delay } from "node:timers/promises";
import { connect, createServer, type TLSSocket } from "node:tls";
import { sha256Bytes, type LedgerCutIdentity } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import {
  readFleetAssignmentClient,
  runFleetReplicaPullClient,
  runFleetWriteClient,
  type FleetReplicaPullClientOptions,
  type FleetWriteClientOptions,
} from "../src/fleet/edge.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import {
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetCut,
  type FleetFrameV1,
} from "../src/fleet/contract.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
const replicaQuota = 64 * 1024 * 1024;
// A `node --test` timeout suspends the test body at its current await and never resumes it, so `try…finally`
// teardown does not run on the timeout path. Every fixture therefore owns its OS resources and every test hands
// `fixture.close` to `t.after`, which node:test does run after a timeout. Sockets and edge children are dropped
// before the centers so `server.close()` is never left waiting on a peer that outlived the test.
function reclaimer() {
  const closers: Array<() => void> = [],
    centers: FleetTlsCenter[] = [];
  return {
    track: (close: () => void) => {
      closers.push(close);
    },
    hold: async (opening: Promise<FleetTlsCenter>) => {
      const center = await opening;
      centers.push(center);
      return center;
    },
    reclaim: async () => {
      for (const close of closers.splice(0)) close();
      for (const center of centers.splice(0)) await center.close();
    },
  };
}
type RoundTripOptions = FleetWriteClientOptions & Pick<FleetReplicaPullClientOptions, "viewRoot" | "edgeKillpoint">;
async function runFleetRoundTrip(options: RoundTripOptions) {
  const peer = {
    hostname: options.hostname,
    port: options.port,
    ca: options.ca,
    servername: options.servername,
    nodeId: options.nodeId,
    credential: options.credential,
    assignmentId: options.assignmentId,
    timeoutMs: options.timeoutMs,
  };
  await runFleetReplicaPullClient({ ...peer, viewRoot: options.viewRoot, diskQuotaBytes: replicaQuota });
  const write = await runFleetWriteClient({ ...options, channel: "replica" });
  // The applied receipt can precede host-side ledger visibility. Anchor the pull to the
  // same assignment read that the edge can observe, or it may legally return the prior current cut.
  if (write.center.outcome === "applied" && write.center.revision !== null)
    await waitForCenterLedgerRevision(peer, write.center.revision, options.timeoutMs ?? 5_000);
  const pulled = await runFleetReplicaPullClient({
    ...peer,
    viewRoot: options.viewRoot,
    diskQuotaBytes: replicaQuota,
    onFrame: options.onFrame,
    edgeKillpoint: options.edgeKillpoint,
  });
  return { ...write, replica: pulled.replica };
}
test(
  "production Fleet TLS path stages claims, writes without edge Git, atomically snapshots/deltas, and recovers ACK",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    let center = await fixture.center();
    const firstBody = `# Fleet\n\n${"a".repeat(300 * 1024)}\n`,
      edgeRoot = path.join(fixture.root, "edge");
    const first = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot: edgeRoot,
      changes: [{ path: fixture.path, body: firstBody }],
    });
    assert.equal(first.center.outcome, "applied");
    assert.equal(first.replica.outcome, "applied");
    assert.equal(first.replica.ackCut, first.center.revision);
    assert.match(first.descriptors[0]!.ref, /^doc-sync-claims\/[0-9a-f]{32}$/u);
    assert.equal("nodeId" in first.descriptors[0]!, false);
    assert.equal("actor" in first.descriptors[0]!, false);
    const currentOne = JSON.parse(
        readFileSync(
          path.join(edgeRoot, "repos", fixture.assignment.repoId, "views", fixture.assignment.viewId, "current.json"),
          "utf8",
        ),
      ) as { manifestDigest: string; cut: FleetCut },
      durable = JSON.parse(readFileSync(path.join(fixture.stateRoot, "state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(currentOne.cut.revision, first.center.revision);
    assert.equal("commitSha" in currentOne.cut, false);
    assert.equal("transferId" in currentOne, false);
    assert.notEqual(currentOne.cut.headDigest.slice(7), currentOne.manifestDigest);
    assert.equal("transfers" in durable, false);
    assert.equal("cursors" in durable, false);
    assert.equal(JSON.stringify(durable).includes(firstBody), false);
    const secondBody = `${firstBody}delta\n`,
      second = await runFleetRoundTrip({
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.assignment.nodeId,
        credential: "machine-secret",
        assignmentId: fixture.assignment.assignmentId,
        viewRoot: edgeRoot,
        changes: [{ path: fixture.path, body: secondBody, baseBlobSha256: sha256Bytes(Buffer.from(firstBody)) }],
      });
    assert.equal(second.center.outcome, "applied");
    assert.equal(second.replica.outcome, "applied");
    assert.ok(second.replica.ackCut > first.replica.ackCut);
    const replica = center.replicaReceipt(
      second.center.opId,
      fixture.assignment.nodeId,
      fixture.assignment.viewId,
      fixture.assignment.repoId,
    );
    assert.deepEqual(replica.visibility, { kind: "replica", viewId: fixture.assignment.viewId });
    assert.equal(replica.proof?.worktreeVisible, true);
    const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret"),
      forged = await peer.request({
        schema: "fleet.ack/v1",
        messageId: "forged",
        transferId: "not-issued",
        cut: { revision: second.center.revision!, headDigest: `sha256:${"0".repeat(64)}` },
        manifestDigest: "0".repeat(64),
      });
    assert.equal(forged.schema, "fleet.error/v1");
    if (forged.schema === "fleet.error/v1") assert.equal(forged.code, "invalid_ack");
    peer.close();
    await center.close();
    center = await fixture.center();
    const recovered = center.replicaReceipt(
      second.center.opId,
      fixture.assignment.nodeId,
      fixture.assignment.viewId,
      fixture.assignment.repoId,
    );
    assert.equal(recovered.opId, replica.opId);
    assert.equal(recovered.proof?.ackCut, replica.proof?.ackCut);
    const shown = await fixture.host.run(
      fixture.assignment.repoId,
      { kind: "doc-show", path: fixture.path },
      fixture.auth,
    );
    assert.equal(shown.evidence, secondBody);
  },
);
test("center rejects the retired full-entry/Git-cut durable transfer shape", async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  mkdirSync(fixture.stateRoot, { recursive: true });
  writeFileSync(
    path.join(fixture.stateRoot, "state.json"),
    JSON.stringify({
      uploads: {},
      cursors: {},
      transfers: {
        legacy: {
          entries: [{ path: fixture.path, body: "retired" }],
          cut: { revision: 1, commitSha: "a".repeat(40), headDigest: `sha256:${"b".repeat(64)}` },
        },
      },
    }),
  );
  await assert.rejects(fixture.center(), /retired delivery state/u);
});
test("split UTF-8 frame preserves multibyte text in both TLS directions", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const probe = serializeFleetFrame({
      schema: "fleet.upload.begin/v1",
      messageId: "unicode-probe",
      assignmentId: fixture.assignment.assignmentId,
      content: { sha256: sha256Bytes(Buffer.from("unicode")), size: 7, mediaType: "text/雪" },
    }),
    probeBytes = Buffer.from(probe),
    split = probeBytes.indexOf(Buffer.from("雪")) + 1;
  for (const direction of ["center", "edge"]) {
    const decoder = new FleetUtf8LineDecoder();
    assert.deepEqual(
      [...decoder.push(probeBytes.subarray(0, split)), ...decoder.push(probeBytes.subarray(split))],
      [probe.slice(0, -1)],
      direction,
    );
  }
  const center = await fixture.center();
  const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret"),
    inbound = await peer.split(
      {
        schema: "fleet.upload.begin/v1",
        messageId: "unicode-in",
        assignmentId: fixture.assignment.assignmentId,
        content: { sha256: sha256Bytes(Buffer.from("unicode")), size: 7, mediaType: "text/雪" },
      },
      "雪",
    );
  assert.equal(inbound.schema, "fleet.upload.ready/v1");
  peer.close();
  await center.close();
  let sawUpload = false,
    buffer = "";
  const scripted = createServer({ key: fixture.key, cert: fixture.cert }, (socket) => {
    fixture.track(() => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const frame = parseFleetFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (frame.schema === "fleet.session.hello/v1")
          socket.write(
            serializeFleetFrame({
              schema: "fleet.session.ready/v1",
              messageId: "split_session",
              inReplyTo: frame.messageId,
              sessionId: "split-session",
              maxFrameBytes: 96 * 1024,
              chunkBytes: 64 * 1024,
            }),
          );
        else if (frame.schema === "fleet.assignment.get/v1")
          splitWrite(
            socket,
            {
              schema: "fleet.assignment.result/v1",
              messageId: "split_assignment",
              inReplyTo: frame.messageId,
              assignmentId: frame.assignmentId,
              repoId: fixture.assignment.repoId,
              scope: {
                kind: "task",
                taskId: fixture.assignment.taskId,
                executionId: fixture.assignment.executionId,
                paths: ["tasks/task-fleet-fleet/雪.md"],
              },
              baseLedgerSha: { repoId: fixture.assignment.repoId, revision: 0, headDigest: `sha256:${"0".repeat(64)}` },
              expiresAt: fixture.assignment.expiresAt,
              writerEpoch: 1,
            },
            "雪",
          );
        else if (frame.schema === "fleet.upload.begin/v1") {
          sawUpload = true;
          socket.write(
            serializeFleetFrame({
              schema: "fleet.error/v1",
              messageId: "split_stop",
              inReplyTo: frame.messageId,
              code: "probe_complete",
              retryable: false,
              resumeOffset: null,
            }),
          );
        }
      }
    });
  });
  fixture.track(() => scripted.close());
  await new Promise<void>((resolve, reject) => {
    scripted.once("error", reject);
    scripted.listen(0, "127.0.0.1", () => resolve());
  });
  const address = scripted.address();
  if (!address || typeof address === "string") throw new Error("scripted TLS server did not bind");
  await assert.rejects(
    runFleetWriteClient({
      port: address.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      channel: "replica",
      changes: [{ path: fixture.path, body: "unicode" }],
    }),
    (error: unknown) => {
      assert.equal((error as { readonly code?: string }).code, "probe_complete");
      return true;
    },
  );
  assert.equal(sawUpload, true);
});
test("failed Fleet hello closes the socket before session ownership transfers", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  for (const mode of ["timeout", "remote-error", "unexpected-frame"] as const) {
    const closed = Promise.withResolvers<void>(),
      server = createServer({ key: fixture.key, cert: fixture.cert }, (socket) => {
        fixture.track(() => socket.destroy());
        socket.once("close", closed.resolve);
        const decoder = new FleetUtf8LineDecoder();
        socket.on("data", (chunk) => {
          for (const line of decoder.push(chunk)) {
            const hello = parseFleetFrame(line);
            assert.equal(hello.schema, "fleet.session.hello/v1");
            // Withhold a response entirely to exercise the handshake timeout without a sleep.
            if (mode === "timeout") continue;
            socket.write(
              serializeFleetFrame(
                mode === "remote-error"
                  ? {
                      schema: "fleet.error/v1",
                      messageId: "hello-rejected",
                      inReplyTo: hello.messageId,
                      code: "hello_rejected",
                      retryable: false,
                      resumeOffset: null,
                    }
                  : hello,
              ),
            );
          }
        });
      });
    fixture.track(() => server.close());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("hello test server did not bind");
    await assert.rejects(
      readFleetAssignmentClient({
        port: address.port,
        ca: fixture.cert,
        nodeId: fixture.assignment.nodeId,
        credential: "machine-secret",
        assignmentId: fixture.assignment.assignmentId,
        timeoutMs: mode === "timeout" ? 5 : 5_000,
      }),
      mode === "timeout"
        ? /Fleet response timeout/u
        : mode === "remote-error"
          ? /hello_rejected/u
          : /session ready expected/u,
    );
    // A rejected open must release its own socket; the fixture has not reclaimed it yet.
    await closed.promise;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
test(
  "production Fleet session rejects provenance, revocation, expiry, content mismatch, and ninth active upload before L1",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      before = fixture.eventCount();
    let peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret");
    fixture.setAssignmentDelay(50);
    await assert.rejects(
      runFleetRoundTrip({
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.assignment.nodeId,
        credential: "machine-secret",
        assignmentId: fixture.assignment.assignmentId,
        viewRoot: path.join(fixture.root, "timeout-edge"),
        changes: [{ path: fixture.path, body: "timeout" }],
        timeoutMs: 5,
      }),
      /Fleet response timeout/u,
    );
    fixture.setAssignmentDelay(0);
    const spoofed = await peer.raw({
      schema: "fleet.upload.begin/v1",
      messageId: "spoof",
      assignmentId: fixture.assignment.assignmentId,
      content: { sha256: "a".repeat(64), size: 1, mediaType: "text/plain", actor: { personId: "forged" } },
    });
    assert.equal(spoofed.schema, "fleet.error/v1");
    if (spoofed.schema === "fleet.error/v1") assert.equal(spoofed.code, "invalid_frame");
    for (let index = 0; index < 9; index += 1) {
      const response = await peer.request({
        schema: "fleet.upload.begin/v1",
        messageId: `busy-${index}`,
        assignmentId: fixture.assignment.assignmentId,
        content: { sha256: sha256Bytes(Buffer.from(`partial-${index}`)), size: 9, mediaType: "text/plain" },
      });
      if (index < 8) assert.equal(response.schema, "fleet.upload.ready/v1");
      else {
        assert.equal(response.schema, "fleet.error/v1");
        if (response.schema === "fleet.error/v1") {
          assert.equal(response.code, "busy");
          assert.equal(response.retryable, true);
        }
      }
    }
    peer.close();
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret");
    const declared = Buffer.from("abc"),
      ready = await peer.request({
        schema: "fleet.upload.begin/v1",
        messageId: "bad-begin",
        assignmentId: fixture.assignment.assignmentId,
        content: { sha256: sha256Bytes(declared), size: declared.byteLength, mediaType: "text/plain" },
      });
    assert.equal(ready.schema, "fleet.upload.ready/v1");
    if (ready.schema !== "fleet.upload.ready/v1") throw new Error("ready expected");
    await peer.request({
      schema: "fleet.upload.chunk/v1",
      messageId: "bad-chunk",
      uploadId: ready.uploadId,
      offset: ready.resumeOffset,
      dataBase64: Buffer.from("xyz").toString("base64"),
    });
    // Replay comparison reads only the window a retried chunk names: identical
    // bytes at a non-zero offset are accepted, divergent bytes are refused.
    const replayed = await peer.request({
      schema: "fleet.upload.chunk/v1",
      messageId: "replay-chunk",
      uploadId: ready.uploadId,
      offset: 1,
      dataBase64: Buffer.from("yz").toString("base64"),
    });
    assert.equal(replayed.schema, "fleet.upload.ready/v1");
    const divergent = await peer.request({
      schema: "fleet.upload.chunk/v1",
      messageId: "divergent-chunk",
      uploadId: ready.uploadId,
      offset: 1,
      dataBase64: Buffer.from("zz").toString("base64"),
    });
    assert.equal(divergent.schema, "fleet.error/v1");
    if (divergent.schema === "fleet.error/v1") assert.equal(divergent.code, "upload_replay_mismatch");
    const bad = await peer.request({
      schema: "fleet.upload.finish/v1",
      messageId: "bad-finish",
      uploadId: ready.uploadId,
    });
    assert.equal(bad.schema, "fleet.error/v1");
    if (bad.schema === "fleet.error/v1") assert.equal(bad.code, "content_claim_mismatch");
    peer.close();
    fixture.setActive(false);
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret");
    const revoked = await peer.request({
      schema: "fleet.assignment.get/v1",
      messageId: "revoked",
      assignmentId: fixture.assignment.assignmentId,
    });
    assert.equal(revoked.schema, "fleet.error/v1");
    if (revoked.schema === "fleet.error/v1") assert.equal(revoked.code, "credential_revoked");
    peer.close();
    fixture.setActive(true);
    fixture.setExpiry("2000-01-01T00:00:00.000Z");
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret");
    const expired = await peer.request({
      schema: "fleet.assignment.get/v1",
      messageId: "expired",
      assignmentId: fixture.assignment.assignmentId,
    });
    assert.equal(expired.schema, "fleet.error/v1");
    if (expired.schema === "fleet.error/v1") assert.equal(expired.code, "assignment_rejected");
    peer.close();
    assert.equal(fixture.eventCount(), before);
  },
);
test(
  "disconnect and crash recovery preserve upload/view/ACK idempotency while an unacked replica never holds the repo mutex",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t),
      edgeRoot = path.join(fixture.root, "fault-edge"),
      bodyFile = path.join(fixture.root, "fault-body"),
      markerFile = path.join(fixture.root, "fault-marker");
    t.after(() => fixture.close());
    let center = await fixture.center();
    const firstBody = `# Recovery\n\n${"r".repeat(300 * 1024)}\n`;
    writeFileSync(bodyFile, firstBody);
    let base = {
      port: center.port,
      caFile: fixture.certFile,
      servername: "localhost",
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      repoId: fixture.assignment.repoId,
      viewRoot: edgeRoot,
      path: fixture.path,
      bodyFile,
      markerFile,
      label: "fault",
    };
    const initial = fixture.eventCount();
    assert.equal((await runFaultChild(fixture, { ...base, killAfterPartialUpload: true })).code, 74);
    assert.equal(fixture.eventCount(), initial);
    assert.ok(Number(readFileSync(markerFile, "utf8")) > 0);
    rmSync(markerFile, { force: true });
    await center.close();
    center = await fixture.center();
    base = { ...base, port: center.port };
    assert.equal((await runFaultChild(fixture, { ...base, killOnSchema: "fleet.upload.result/v1" })).code, 73);
    assert.equal(fixture.eventCount(), initial);
    rmSync(markerFile, { force: true });
    const first = await runFaultChild(fixture, base);
    assert.equal(first.code, 0);
    await waitForEventCount(fixture, initial + 1);
    const firstCut = center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      secondBody = `${firstBody}second\n`,
      secondBase = await ledgerBase(fixture);
    writeFileSync(bodyFile, secondBody);
    const beforeSecond = fixture.eventCount();
    assert.equal(
      (
        await runFaultChild(fixture, {
          ...base,
          baseLedgerSha: secondBase.ledger,
          baseBlobSha256: sha256Bytes(Buffer.from(firstBody)),
          killOnSchema: "fleet.doc.result/v1",
        })
      ).code,
      73,
    );
    await waitForEventCount(fixture, beforeSecond + 1);
    assert.equal(
      center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      firstCut,
    );
    const status = fixture.host.run(
      fixture.assignment.repoId,
      { kind: "doc-status", paths: [fixture.path] },
      fixture.auth,
    );
    const probe = await fixture.host.run(
      fixture.assignment.repoId,
      { kind: "task-create", taskId: "task-hol-probe", title: "HOL probe" },
      fixture.auth,
    );
    assert.equal(probe.outcome, "applied");
    await waitForReceiptCommit(fixture.host, fixture.assignment.repoId, probe.opId, fixture.assignment);
    assert.equal((await status).outcome, "applied");
    assert.equal(
      center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      firstCut,
    );
    const afterProbe = fixture.eventCount();
    assert.equal(
      (
        await runFaultChild(fixture, {
          ...base,
          baseLedgerSha: secondBase.ledger,
          baseBlobSha256: sha256Bytes(Buffer.from(firstBody)),
        })
      ).code,
      0,
    );
    assert.equal(fixture.eventCount(), afterProbe);
    const thirdBody = `${secondBody}third\n`,
      thirdBase = await ledgerBase(fixture);
    writeFileSync(bodyFile, thirdBody);
    const beforeThird = fixture.eventCount();
    assert.equal(
      (
        await runFaultChild(fixture, {
          ...base,
          baseLedgerSha: thirdBase.ledger,
          baseBlobSha256: sha256Bytes(Buffer.from(secondBody)),
          edgeKillpoint: "before_current_rename",
        })
      ).code,
      75,
    );
    await waitForEventCount(fixture, beforeThird + 1);
    rmSync(markerFile, { force: true });
    assert.equal(
      (
        await runFaultChild(fixture, {
          ...base,
          baseLedgerSha: thirdBase.ledger,
          baseBlobSha256: sha256Bytes(Buffer.from(secondBody)),
        })
      ).code,
      0,
    );
    assert.equal(fixture.eventCount(), beforeThird + 1);
    const fourthBody = `${thirdBody}fourth\n`,
      fourthBase = await ledgerBase(fixture);
    writeFileSync(bodyFile, fourthBody);
    const beforeFourth = fixture.eventCount();
    assert.equal(
      (
        await runFaultChild(fixture, {
          ...base,
          baseLedgerSha: fourthBase.ledger,
          baseBlobSha256: sha256Bytes(Buffer.from(thirdBody)),
          killOnSchema: "fleet.ack.result/v1",
        })
      ).code,
      73,
    );
    await waitForEventCount(fixture, beforeFourth + 1);
    const ackedBeforeRetry = center
      .status()
      .replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision;
    rmSync(markerFile, { force: true });
    assert.equal(
      (
        await runFaultChild(fixture, {
          ...base,
          baseLedgerSha: fourthBase.ledger,
          baseBlobSha256: sha256Bytes(Buffer.from(thirdBody)),
        })
      ).code,
      0,
    );
    assert.equal(fixture.eventCount(), beforeFourth + 1);
    assert.equal(
      center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      ackedBeforeRetry,
    );
  },
);
async function fleetFixture(t: TestContext, paths: readonly string[] = ["tasks/task-fleet-fleet/notes.md"]) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-one-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path"),
    owned = reclaimer();
  let nodeActive = true,
    expiresAt = "2099-01-01T00:00:00.000Z",
    assignmentDelayMs = 0,
    taskReleaseBarrier: { readonly started: () => void; readonly wait: Promise<void> } | null = null;
  const runtimeArchiveReceipts: Readonly<Record<string, unknown>>[] = [];
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(emptyPath);
  initRepo(repo);
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: fleet\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writePeopleFixture(repo);
  git(repo, "add", "harness");
  git(repo, "commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "fleet-repo", userRoot, createConvenienceLinks: false });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile),
    host = await openDaemonHost({ daemonId: "fleet-center", userRoot });
  t.after(async () => {
    try {
      await owned.reclaim();
    } finally {
      try {
        await host.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  await host.attachmentsSettled();
  const assignment: FleetAssignmentRecord = {
      nodeId: "node-one",
      assignmentId: "assignment-one",
      repoId: "fleet-repo",
      taskId: "task-fleet",
      executionId: "execution-fleet",
      paths,
      viewId: "node-one_task-fleet",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "fleet-edge" } },
    },
    slowAssignment: FleetAssignmentRecord = {
      ...assignment,
      assignmentId: "assignment-slow",
      viewId: "node-one_task-fleet-slow",
    },
    auth = { transportKind: "fleet-tls" as const, assignmentBinding: assignment };
  const created = await host.run(
    assignment.repoId,
    { kind: "task-create", taskId: assignment.taskId, title: "Fleet" },
    auth,
  );
  assert.equal(created.outcome, "applied");
  await waitForFleetPublication(host, assignment.repoId, created.opId, auth);
  await realizeTaskPlanFixture(
    repo,
    String((created as Record<string, unknown>).packagePath),
    (planPath) => host.run(assignment.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    "Fleet",
  );
  const started = await host.run(
    assignment.repoId,
    { kind: "task-start", taskId: assignment.taskId, executionId: assignment.executionId },
    auth,
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForReceiptCommit(host, assignment.repoId, started.opId, assignment);
  return {
    root,
    repo,
    stateRoot,
    writerOptions: fleetHostWriterOptions(userRoot, ["fleet-repo"]),
    path: assignment.paths[0]!,
    assignment,
    slowAssignment,
    auth,
    host,
    key,
    cert,
    certFile,
    emptyPath,
    track: owned.track,
    hold: owned.hold,
    setActive: (value: boolean) => {
      nodeActive = value;
    },
    setExpiry: (value: string) => {
      expiresAt = value;
    },
    setAssignmentDelay: (value: number) => {
      assignmentDelayMs = value;
    },
    blockTaskRelease: () => {
      let started!: () => void, release!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
          started = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      taskReleaseBarrier = { started, wait };
      return { started: startedPromise, release };
    },
    eventCount: () => fleetLedgerRevision(repo, "fleet-repo"),
    runtimeArchiveReceipts,
    center: () =>
      owned.hold(
        listenFleetTls({
          host: {
            ...host,
            runtimeIngress: async (...args: Parameters<typeof host.runtimeIngress>) => {
              const receipt = await host.runtimeIngress(...args);
              if (args[1].kind === "archive") runtimeArchiveReceipts.push(receipt);
              return receipt;
            },
            run: async (...args: Parameters<typeof host.run>) => {
              const barrier = taskReleaseBarrier;
              if (args[1].kind === "task-release" && barrier) {
                barrier.started();
                await barrier.wait;
                if (taskReleaseBarrier === barrier) taskReleaseBarrier = null;
              }
              return host.run(...args);
            },
          },
          stateRoot,
          ...fleetHostWriterOptions(userRoot, ["fleet-repo"]),
          key,
          cert,
          replicaDiskQuotaBytes: replicaQuota,
          authenticate: (nodeId, credential) => nodeId === assignment.nodeId && credential === "machine-secret",
          isNodeActive: () => nodeActive,
          resolveAssignment: async (assignmentId) => {
            if (assignmentDelayMs) await new Promise((resolve) => setTimeout(resolve, assignmentDelayMs));
            return assignmentId === assignment.assignmentId
              ? { ...assignment, expiresAt }
              : assignmentId === slowAssignment.assignmentId
                ? { ...slowAssignment, expiresAt }
                : null;
          },
        }),
      ),
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Fleet Test");
  git(rootDir, "config", "user.email", "fleet@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
function writePeopleFixture(rootDir: string): void {
  const ownerUid = process.getuid?.() ?? 0;
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "fleet-fixture", displayName: "Fleet Fixture", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(ownerUid) }] }], roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`,
  );
}
function localAuthFixture() {
  return {
    transportKind: "unix-socket" as const,
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary" as const,
    },
  };
}
async function rawPeer(
  track: (close: () => void) => void,
  port: number,
  ca: Buffer,
  nodeId: string,
  credential: string,
) {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const candidate = connect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => resolve(candidate));
      candidate.once("error", reject);
    }),
    frames: FleetFrameV1[] = [],
    waiters: Array<(frame: FleetFrameV1) => void> = [];
  track(() => socket.destroy());
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const frame = parseFleetFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  const next = () =>
      frames.length ? Promise.resolve(frames.shift()!) : new Promise<FleetFrameV1>((resolve) => waiters.push(resolve)),
    request = async (frame: FleetFrameV1) => {
      socket.write(serializeFleetFrame(frame));
      return next();
    },
    raw = async (frame: unknown) => {
      socket.write(`${JSON.stringify(frame)}\n`);
      return next();
    },
    split = async (frame: FleetFrameV1, marker: string) => {
      splitWrite(socket, frame, marker);
      return next();
    };
  const hello = await request({
    schema: "fleet.session.hello/v1",
    messageId: "hello",
    protocolVersion: { major: 1, minor: 0 },
    nodeId,
    credential,
  });
  if (hello.schema === "fleet.error/v1") throw new Error(hello.code);
  return { request, raw, split, close: () => socket.destroy() };
}
function splitWrite(socket: TLSSocket, frame: FleetFrameV1, marker: string): void {
  const bytes = Buffer.from(serializeFleetFrame(frame)),
    markerOffset = bytes.indexOf(Buffer.from(marker));
  if (markerOffset < 0) throw new Error("split marker missing");
  socket.setNoDelay(true);
  socket.write(bytes.subarray(0, markerOffset + 1));
  setTimeout(() => socket.write(bytes.subarray(markerOffset + 1)), 100);
}
async function waitForReceiptCommit(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  repoId: string,
  opId: string,
  assignment: FleetAssignmentRecord,
): Promise<void> {
  const deadline = performance.now() + 15_000,
    binding = { transportKind: "fleet-tls" as const, assignmentBinding: assignment };
  do {
    const receipt = await host.run(repoId, { kind: "receipt-show", opId }, binding);
    if (typeof receipt.commitSha === "string") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  throw new Error(`Git materialization did not publish ${opId} within the bounded wait`);
}
async function waitForCenterLedgerRevision(
  peer: Parameters<typeof readFleetAssignmentClient>[0],
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let observed: number;
  do {
    observed = (await readFleetAssignmentClient(peer)).baseLedgerSha.revision;
    if (observed >= expected) return;
    await delay(10);
  } while (performance.now() < deadline);
  assert.ok(
    observed >= expected,
    `center assignment read did not expose ledger revision ${expected} within the bounded wait`,
  );
}
async function waitForEventCount(fixture: Awaited<ReturnType<typeof fleetFixture>>, expected: number): Promise<void> {
  const deadline = performance.now() + 15_000;
  do {
    if (fixture.eventCount() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  assert.equal(fixture.eventCount(), expected, "SQLite ledger did not reach the expected bounded cut");
}
async function ledgerBase(fixture: Awaited<ReturnType<typeof fleetFixture>>): Promise<{ ledger: LedgerCutIdentity }> {
  const status = await fixture.host.run(
    fixture.assignment.repoId,
    { kind: "doc-status", paths: [fixture.path] },
    fixture.auth,
  );
  if (status.detail?.kind !== "doc_sync") throw new Error("doc status lacks ledger cut");
  return { ledger: status.detail.currentLedgerSha };
}
function runFaultChild(
  fixture: Awaited<ReturnType<typeof fleetFixture>>,
  config: Record<string, unknown>,
): Promise<{ code: number; output: string }> {
  const configFile = path.join(fixture.root, `fault-${Date.now()}-${Math.random()}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "fixtures/fleet-edge-child.mjs"), configFile],
      { env: { ...process.env, PATH: fixture.emptyPath }, stdio: ["ignore", "pipe", "pipe"] },
    );
    fixture.track(() => child.kill("SIGKILL"));
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === null || ![0, 73, 74, 75].includes(code)) reject(new Error(`fault edge exited ${code}: ${errors}`));
      else resolve({ code, output });
    });
  });
}
