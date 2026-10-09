// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:tls";
import { READ_MODEL_SCHEMA_GENERATION, sha256Bytes, type LedgerCutIdentity } from "@harness-anything/kernel";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { digestId } from "../src/fleet/center-transport.ts";
import {
  readFleetRepositoryMetadataClient,
  runFleetReplicaPullClient,
  runFleetWriteClient,
  type FleetReplicaPullClientOptions,
  type FleetWriteClientOptions,
} from "../src/fleet/edge.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import {
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetCut,
  type FleetFrameV1,
} from "../src/fleet/contract.ts";
import {
  fleetFixture,
  git,
  localAuthFixture,
  rawPeer,
  replicaQuota,
  splitWrite,
  waitForReceiptCommit,
} from "./fleet-tls-session.fixture.ts";
type RoundTripOptions = FleetWriteClientOptions & Pick<FleetReplicaPullClientOptions, "viewRoot" | "edgeKillpoint">;
test(
  "fact record from the real CLI parser crosses TLS and reaches the canonical ledger",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      { nodeId, repoId, taskId } = fixture.subject,
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      metadata = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "fact-metadata", repoId }),
      statement = "The center records the complete edge observation. ".repeat(20),
      parsed = parseThinCommand([
        "fact",
        "record",
        "--task",
        taskId,
        "--statement",
        statement,
        "--source",
        "test:fleet-fact-cli",
        "--confidence",
        "high",
      ]);
    assert.equal(metadata.schema, "fleet.repo.metadata.result/v1");
    assert.equal(parsed.ok, true);
    if (metadata.schema !== "fleet.repo.metadata.result/v1" || !parsed.ok) return;
    const result = await peer.request({
      schema: "fleet.task.command/v1",
      messageId: "record-fact",
      writerEpoch: metadata.writerEpoch,
      opId: "record-fact",
      repoId,
      taskId,
      action: parsed.command.action,
      docChanges: null,
      mirrorBaseCut: null,
    });
    assert.equal(result.schema, "fleet.task.result/v1");
    if (result.schema !== "fleet.task.result/v1") return;
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    assert.equal(result.receipt?.status, "accepted_durable");
    const shown = await fixture.host.run(repoId, { kind: "fact-show", factId: result.receipt?.factId }, fixture.auth);
    assert.equal(shown.outcome, "applied", JSON.stringify(shown));
    assert.ok(String(shown.evidence).includes(statement), String(shown.evidence));
    assert.ok(String(shown.evidence).includes("test:fleet-fact-cli"), String(shown.evidence));
  },
);

async function runFleetRoundTrip(options: RoundTripOptions) {
  const peer = {
    hostname: options.hostname,
    port: options.port,
    ca: options.ca,
    servername: options.servername,
    nodeId: options.nodeId,
    credential: options.credential,
    repoId: options.repoId,
    timeoutMs: options.timeoutMs,
  };
  await runFleetReplicaPullClient({ ...peer, viewRoot: options.viewRoot, diskQuotaBytes: replicaQuota });
  const write = await runFleetWriteClient({ ...options, channel: "replica" });
  // The applied receipt can precede host-side ledger visibility. Anchor the pull to the
  // same repository metadata read that the edge can observe, or it may legally return the prior current cut.
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
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      executionId: fixture.subject.executionId,
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
          path.join(edgeRoot, "repos", fixture.subject.repoId, "views", fixture.subject.viewId, "current.json"),
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
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        executionId: fixture.subject.executionId,
        viewRoot: edgeRoot,
        changes: [{ path: fixture.path, body: secondBody, baseBlobSha256: sha256Bytes(Buffer.from(firstBody)) }],
      });
    assert.equal(second.center.outcome, "applied");
    assert.equal(second.replica.outcome, "applied");
    assert.ok(second.replica.ackCut > first.replica.ackCut);
    const replica = center.replicaReceipt(
      second.center.opId,
      fixture.subject.nodeId,
      fixture.subject.viewId,
      fixture.subject.repoId,
    );
    assert.deepEqual(replica.visibility, { kind: "replica", viewId: fixture.subject.viewId });
    assert.equal(replica.proof?.worktreeVisible, true);
    const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
      forged = await peer.request({
        schema: "fleet.ack/v1",
        messageId: "forged",
        transferId: "not-issued",
        cut: {
          revision: second.center.revision!,
          headDigest: `sha256:${"0".repeat(64)}`,
          schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
        },
        manifestDigest: "0".repeat(64),
      });
    assert.equal(forged.schema, "fleet.error/v1");
    if (forged.schema === "fleet.error/v1") assert.equal(forged.code, "invalid_ack");
    peer.close();
    await center.close();
    center = await fixture.center();
    const recovered = center.replicaReceipt(
      second.center.opId,
      fixture.subject.nodeId,
      fixture.subject.viewId,
      fixture.subject.repoId,
    );
    assert.equal(recovered.opId, replica.opId);
    assert.equal(recovered.proof?.ackCut, replica.proof?.ackCut);
    const shown = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "doc-show", path: fixture.path },
      fixture.auth,
    );
    assert.equal(shown.evidence, secondBody);
  },
);
// A settled unregistration cuts the node's live session before the operation returns; whatever
// authenticates afterwards still finds no owner for its frames. Both layers are observable here.
test(
  "a node unregistered while it stays connected is cut, and its next session has no owner",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      { nodeId, repoId, taskId } = fixture.subject,
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      answer = (frame: FleetFrameV1) =>
        frame.schema === "fleet.error/v1"
          ? frame.code
          : frame.schema === "fleet.task.result/v1"
            ? frame.outcome
            : frame.schema,
      assigned = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "subject", repoId });
    assert.equal(assigned.schema, "fleet.repo.metadata.result/v1");
    if (assigned.schema !== "fleet.repo.metadata.result/v1") return;
    const receipt = (messageId: string) =>
        peer.request({ schema: "fleet.receipt.get/v1", messageId, repoId, opId: "op-unknown" }),
      task = (opId: string, action: Record<string, unknown>) =>
        peer.request({
          schema: "fleet.task.command/v1",
          messageId: opId,
          writerEpoch: assigned.writerEpoch,
          opId,
          repoId,
          taskId,
          action: { ...action, taskId },
          docChanges: null,
          mirrorBaseCut: null,
        } as FleetFrameV1),
      progress = (opId: string) => task(opId, { kind: "task-progress-append", text: opId });
    // While the node is registered the same three frames are answered.
    assert.equal(answer(await receipt("receipt-while-registered")), "fleet.receipt.result/v1");
    await assert.rejects(task("show-while-registered", { kind: "task-show" }), /closed schema/u);
    assert.equal(answer(await progress("progress-while-registered")), "applied");
    const before = fixture.eventCount();

    signInAt(fixture.userRoot, "person-admin");
    const admin = fixture.admin(center),
      listed = (await admin.run({ operation: "node-list" })).nodes as { nodeId: string; version: string }[],
      removed = await admin.run({
        operation: "node-unregister",
        operationId: "unregister-connected-node",
        nodeId,
        expectedVersion: listed.find((node) => node.nodeId === nodeId)!.version,
      });
    assert.equal(removed.ok, true, JSON.stringify(removed));

    // The settled removal cut the existing session: no frame on it is processed or answered any more.
    await peer.closed;
    assert.equal(fixture.eventCount(), before, "nothing was written for the unregistered node");
    // A session that authenticates afterwards still resolves no owner for the frames that act for somebody.
    const next = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      refused = await next.request({
        schema: "fleet.receipt.get/v1",
        messageId: "receipt-after-reconnect",
        repoId,
        opId: "op-unknown",
      });
    assert.equal(answer(refused), "node_owner_unregistered");
    next.close();
  },
);
// Consent is a person's own confirmation. The connection authenticated a machine, so the owner the center
// resolves for it can hold every permission on the repository and still cannot consent through the node.
test(
  "a node acting for its owner cannot consent, and the same person signed in at the center can",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t, undefined, "strict");
    t.after(() => fixture.close());
    const { nodeId, repoId, taskId, executionId } = fixture.subject,
      reviewId = "review-fleet",
      packageDir = path.join(fixture.repo, "harness", fixture.packagePath),
      delivery = git(fixture.repo, "rev-parse", "HEAD"),
      applied = async (action: Parameters<typeof fixture.host.run>[1], auth = fixture.auth) => {
        const receipt = await fixture.host.run(repoId, action, auth);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      };
    // An approved, independently reviewed cut: consent is the one thing completion still lacks.
    await applied({
      kind: "fact-record",
      taskId,
      statement: "The fleet fixture delivery exists.",
      evidenceSource: "harness/harness.yaml",
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
    });
    writeFileSync(
      path.join(packageDir, "closeout.md"),
      `# Closeout\n\n## Summary\n\nDelivery ${delivery} is ready.\n\n` +
        "## Verification\n\nThe consent source is exercised over TLS.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNone.\n",
    );
    await applied({ kind: "doc-submit", paths: [`${fixture.packagePath}/closeout.md`] }, localAuthFixture());
    await applied({ kind: "task-submit", taskId, executionId, commitSha: delivery });
    await applied({ kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Owner forwards the cut." });
    mkdirSync(path.join(packageDir, "artifacts", "reports"), { recursive: true });
    writeFileSync(
      path.join(packageDir, "artifacts", "reports", "fleet.md"),
      `# Review ${reviewId}\n\nIndependent review findings recorded.\n`,
    );
    writeFileSync(
      path.join(fixture.repo, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Independent review passed.", evidenceChecked: ["tests"] }),
    );
    const review = { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" } as const;
    const selfReview = await fixture.host.run(repoId, review, localAuthFixture());
    assert.equal(selfReview.code, "actor_unauthorized", JSON.stringify(selfReview));
    fixture.owners.keycloak.account("person-reviewer");
    fixture.owners.keycloak.permit("person-reviewer", repoId, ["task-review-execution"]);
    signInAt(fixture.userRoot, "person-reviewer");
    await applied(review, localAuthFixture());
    signInAt(fixture.userRoot, "person-owner");
    // The reviewer's report is accepted at the center, so completion finds no document left to carry.
    await applied({ kind: "doc-submit", taskId }, localAuthFixture());

    const center = await fixture.center(),
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      assigned = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "subject", repoId });
    assert.equal(assigned.schema, "fleet.repo.metadata.result/v1");
    if (assigned.schema !== "fleet.repo.metadata.result/v1") return;
    const fromNode = async (opId: string, action: Record<string, unknown>) => {
        const result = await peer.request({
          schema: "fleet.task.command/v1",
          messageId: opId,
          writerEpoch: assigned.writerEpoch,
          opId,
          repoId,
          taskId,
          action: { ...action, taskId, executionId },
          docChanges: null,
          mirrorBaseCut: null,
        } as FleetFrameV1);
        t.diagnostic(JSON.stringify({ opId, result }));
        return result.schema === "fleet.task.result/v1"
          ? { outcome: result.outcome, code: result.code }
          : { outcome: result.schema, code: result.schema === "fleet.error/v1" ? result.code : null };
      },
      before = fixture.eventCount();
    assert.deepEqual(await fromNode("consent-from-node", { kind: "task-review-consent", reviewId }), {
      outcome: "op_rejected",
      code: "human_confirmation_required",
    });
    assert.equal(fixture.eventCount(), before, "the node's consent wrote nothing");
    assert.deepEqual(await fromNode("complete-without-consent", { kind: "task-complete" }), {
      outcome: "op_rejected",
      code: "consent_missing",
    });
    assert.equal(fixture.eventCount(), before, "the task stays open without a consent");

    // The same person, signed in at the center: the consent is theirs, and the node may then complete.
    signInAt(fixture.userRoot, "person-owner");
    await applied(
      { kind: "task-review-consent", taskId, executionId, reviewId },
      await new OidcSessionService(fixture.userRoot).bind({ transportKind: "unix-socket" }),
    );
    assert.deepEqual(await fromNode("complete-after-consent", { kind: "task-complete" }), {
      outcome: "applied",
      code: null,
    });
  },
);
// Historical exact checkpoints are covered end-to-end in fleet-checkpoint-delivery.integration.test.ts.
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
      repoId: fixture.subject.repoId,
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
  const peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
    inbound = await peer.split(
      {
        schema: "fleet.upload.begin/v1",
        messageId: "unicode-in",
        repoId: fixture.subject.repoId,
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
          splitWrite(
            socket,
            {
              schema: "fleet.session.ready/v1",
              messageId: "split_session",
              inReplyTo: frame.messageId,
              sessionId: "split-session",
              maxFrameBytes: 96 * 1024,
              chunkBytes: 64 * 1024,
              loginAuthority: { url: "https://example.invalid", realm: "雪", clientId: "test" },
            },
            "雪",
          );
        else if (frame.schema === "fleet.repo.metadata.get/v1")
          socket.write(
            serializeFleetFrame({
              schema: "fleet.repo.metadata.result/v1",
              messageId: "split_metadata",
              inReplyTo: frame.messageId,
              personId: "person-owner",
              actionAllowed: null,
              repoId: fixture.subject.repoId,
              baseLedgerSha: { repoId: fixture.subject.repoId, revision: 0, headDigest: `sha256:${"0".repeat(64)}` },
              writerEpoch: 1,
            }),
          );
        else if (frame.schema === "fleet.upload.begin/v1") {
          sawUpload = true;
          socket.write(
            serializeFleetFrame({
              schema: "fleet.error/v1",
              messageId: "split_stop",
              inReplyTo: frame.messageId,
              code: "probe_complete",
              message: "Probe complete.",
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
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      executionId: fixture.subject.executionId,
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
                      message: "Session hello rejected.",
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
      readFleetRepositoryMetadataClient({
        port: address.port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
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
  "production Fleet session rejects provenance, revocation, owner removal, content mismatch, and ninth active upload before L1",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const conflictingContent = { sha256: "d".repeat(64), size: 1, mediaType: "text/plain" },
      conflictingUploadId = digestId(
        fixture.subject.nodeId,
        fixture.subject.repoId,
        conflictingContent.sha256,
        String(conflictingContent.size),
        conflictingContent.mediaType,
      );
    mkdirSync(fixture.stateRoot, { recursive: true });
    writeFileSync(
      path.join(fixture.stateRoot, "state.json"),
      JSON.stringify({
        uploads: {
          "foreign-upload": {
            nodeId: "node-two",
            repoId: fixture.subject.repoId,
            content: { sha256: "e".repeat(64), size: 1, mediaType: "text/plain" },
            descriptor: null,
          },
          [conflictingUploadId]: {
            nodeId: fixture.subject.nodeId,
            repoId: fixture.subject.repoId,
            content: { ...conflictingContent, size: 2 },
            descriptor: null,
          },
        },
      }),
    );
    const center = await fixture.center(1),
      before = fixture.eventCount();
    await assert.rejects(
      rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "wrong-machine-secret"),
      /authentication_failed/u,
    );
    let peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
    const replayedHello = await peer.request({
      schema: "fleet.session.hello/v1",
      messageId: "replayed-hello",
      protocolVersion: { major: 1, minor: 0 },
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
    });
    assert.equal(replayedHello.schema, "fleet.error/v1");
    if (replayedHello.schema === "fleet.error/v1") assert.equal(replayedHello.code, "hello_replayed");
    const preparing = await peer.request({
      schema: "fleet.replica.pull/v1",
      messageId: "insufficient-quota",
      repoId: fixture.subject.repoId,
    });
    assert.equal(preparing.schema, "fleet.replica.preparing/v1");
    const insufficientQuota = await peer.receive();
    assert.equal(insufficientQuota.schema, "fleet.error/v1");
    if (insufficientQuota.schema === "fleet.error/v1")
      assert.equal(insufficientQuota.code, "replica_quota_insufficient");
    const staging = path.join(fixture.repo, ".harness", "fleet-uploads"),
      stagingTarget = path.join(fixture.root, "unsafe-staging-target");
    mkdirSync(stagingTarget);
    symlinkSync(stagingTarget, staging);
    const unsafeStaging = await peer.request({
      schema: "fleet.upload.begin/v1",
      messageId: "unsafe-staging",
      repoId: fixture.subject.repoId,
      content: { sha256: "c".repeat(64), size: 1, mediaType: "text/plain" },
    });
    assert.equal(unsafeStaging.schema, "fleet.error/v1");
    if (unsafeStaging.schema === "fleet.error/v1") assert.equal(unsafeStaging.code, "unsafe_staging");
    rmSync(staging);
    const uploadConflict = await peer.request({
      schema: "fleet.upload.begin/v1",
      messageId: "upload-conflict",
      repoId: fixture.subject.repoId,
      content: conflictingContent,
    });
    assert.equal(uploadConflict.schema, "fleet.error/v1");
    if (uploadConflict.schema === "fleet.error/v1") assert.equal(uploadConflict.code, "upload_conflict");
    fixture.setOwnerLookupDelay(50);
    await assert.rejects(
      runFleetRoundTrip({
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        executionId: fixture.subject.executionId,
        viewRoot: path.join(fixture.root, "timeout-edge"),
        changes: [{ path: fixture.path, body: "timeout" }],
        timeoutMs: 5,
      }),
      /Fleet response timeout/u,
    );
    fixture.setOwnerLookupDelay(0);
    const spoofed = await peer.raw({
      schema: "fleet.upload.begin/v1",
      messageId: "spoof",
      repoId: fixture.subject.repoId,
      content: { sha256: "a".repeat(64), size: 1, mediaType: "text/plain", actor: { personId: "forged" } },
    });
    assert.equal(spoofed.schema, "fleet.error/v1");
    if (spoofed.schema === "fleet.error/v1") assert.equal(spoofed.code, "invalid_frame");
    assert.equal(fixture.transportErrors.length, 0, "a malformed frame is the edge's fault, not a handler failure");
    // A handler that crashes on something other than the frame is reported as such and logged.
    fixture.failOwnerLookup(new Error("registry unreadable"));
    const crashed = await peer.request({
      schema: "fleet.upload.begin/v1",
      messageId: "handler-crash",
      repoId: fixture.subject.repoId,
      content: { sha256: sha256Bytes(Buffer.from("crash")), size: 5, mediaType: "text/plain" },
    });
    fixture.failOwnerLookup(null);
    assert.equal(crashed.schema, "fleet.error/v1");
    if (crashed.schema === "fleet.error/v1") assert.equal(crashed.code, "handler_failed");
    assert.equal(fixture.transportErrors.length, 1);
    assert.match(String((fixture.transportErrors[0] as { error: unknown }).error), /registry unreadable/u);
    const unknownUpload = await peer.request({
      schema: "fleet.upload.chunk/v1",
      messageId: "unknown-upload",
      uploadId: "foreign-upload",
      offset: 0,
      dataBase64: Buffer.from("x").toString("base64"),
    });
    assert.equal(unknownUpload.schema, "fleet.error/v1");
    if (unknownUpload.schema === "fleet.error/v1") assert.equal(unknownUpload.code, "upload_unknown");
    for (let index = 0; index < 9; index += 1) {
      const response = await peer.request({
        schema: "fleet.upload.begin/v1",
        messageId: `busy-${index}`,
        repoId: fixture.subject.repoId,
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
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
    const declared = Buffer.from("abc"),
      ready = await peer.request({
        schema: "fleet.upload.begin/v1",
        messageId: "bad-begin",
        repoId: fixture.subject.repoId,
        content: { sha256: sha256Bytes(declared), size: declared.byteLength, mediaType: "text/plain" },
      });
    assert.equal(ready.schema, "fleet.upload.ready/v1");
    if (ready.schema !== "fleet.upload.ready/v1") throw new Error("ready expected");
    const gap = await peer.request({
      schema: "fleet.upload.chunk/v1",
      messageId: "gap-chunk",
      uploadId: ready.uploadId,
      offset: ready.resumeOffset + 1,
      dataBase64: Buffer.from("x").toString("base64"),
    });
    assert.equal(gap.schema, "fleet.error/v1");
    if (gap.schema === "fleet.error/v1") {
      assert.equal(gap.code, "upload_gap");
      assert.equal(gap.resumeOffset, ready.resumeOffset);
    }
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
    fixture.owners.keycloak.nodeClients.delete(`harness-node-${fixture.subject.nodeId}`);
    peer = await rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret");
    const expired = await peer.request({
      schema: "fleet.repo.metadata.get/v1",
      messageId: "expired",
      repoId: fixture.subject.repoId,
    });
    assert.equal(expired.schema, "fleet.error/v1");
    if (expired.schema === "fleet.error/v1") assert.equal(expired.code, "node_owner_unregistered");
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
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      executionId: fixture.subject.executionId,
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
    const firstCut = center.status().replicas.find((row) => row.viewId === fixture.subject.viewId)?.ackRevision,
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
    assert.equal(center.status().replicas.find((row) => row.viewId === fixture.subject.viewId)?.ackRevision, firstCut);
    const status = fixture.host.run(
      fixture.subject.repoId,
      { kind: "doc-status", paths: [fixture.path] },
      fixture.auth,
    );
    const probe = await fixture.host.run(
      fixture.subject.repoId,
      { kind: "task-create", taskId: "task-hol-probe", title: "HOL probe" },
      fixture.auth,
    );
    assert.equal(probe.outcome, "applied");
    await waitForReceiptCommit(fixture.host, fixture.subject.repoId, probe.opId, fixture.auth);
    assert.equal((await status).outcome, "applied");
    assert.equal(center.status().replicas.find((row) => row.viewId === fixture.subject.viewId)?.ackRevision, firstCut);
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
    const ackedBeforeRetry = center.status().replicas.find((row) => row.viewId === fixture.subject.viewId)?.ackRevision;
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
      center.status().replicas.find((row) => row.viewId === fixture.subject.viewId)?.ackRevision,
      ackedBeforeRetry,
    );
  },
);
async function waitForCenterLedgerRevision(
  peer: Parameters<typeof readFleetRepositoryMetadataClient>[0],
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let observed: number;
  do {
    observed = (await readFleetRepositoryMetadataClient(peer)).baseLedgerSha.revision;
    if (observed >= expected) return;
    await delay(10);
  } while (performance.now() < deadline);
  assert.ok(
    observed >= expected,
    `center repository metadata read did not expose ledger revision ${expected} within the bounded wait`,
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
    fixture.subject.repoId,
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
