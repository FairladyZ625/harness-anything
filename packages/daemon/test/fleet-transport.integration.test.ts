// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connect, createServer, type TLSSocket } from "node:tls";
import {
  makeTaskEventStore,
  registerDaemonRepo,
  sha256Bytes,
  type AgentDefinitionSnapshot,
  type LedgerCutIdentity,
} from "../../kernel/src/index.ts";
import type { AgentRuntimeSessionDto } from "../src/agent-runtime-contract.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import {
  runFleetReplicaPullClient,
  runFleetWriteClient,
  type FleetReplicaPullClientOptions,
  type FleetWriteClientOptions,
} from "../src/fleet/edge.ts";
import {
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetCut,
  type FleetFrameV1,
} from "../src/fleet/contract.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

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
    const fixture = await fleetFixture();
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
  const fixture = await fleetFixture();
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

test("cross-repo transfer identity keeps equal node/view/cut/digest isolated", { timeout: 30_000 }, async (t) => {
  const fixture = await crossRepoFixture();
  t.after(() => fixture.close());
  const center = await fixture.center();
  const edgeRoot = path.join(fixture.root, "edge"),
    body = "# Same cut\n",
    first = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignments[0]!.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignments[0]!.assignmentId,
      viewRoot: edgeRoot,
      changes: [{ path: fixture.path, body }],
    });
  const second = await runFleetRoundTrip({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.assignments[1]!.nodeId,
    credential: "machine-secret",
    assignmentId: fixture.assignments[1]!.assignmentId,
    viewRoot: edgeRoot,
    changes: [{ path: fixture.path, body }],
  });
  assert.equal(first.center.revision, second.center.revision);
  assert.notEqual(first.center.opId, second.center.opId);
  for (const [index, assignment] of fixture.assignments.entries()) {
    const expected = index === 0 ? first : second,
      receipt = center.replicaReceipt(expected.center.opId, assignment.nodeId, assignment.viewId, assignment.repoId),
      current = JSON.parse(
        readFileSync(
          path.join(edgeRoot, "repos", assignment.repoId, "views", assignment.viewId, "current.json"),
          "utf8",
        ),
      ) as { cut: FleetCut };
    assert.equal(receipt.opId, expected.center.opId);
    assert.equal(receipt.outcome, "applied");
    assert.equal(current.cut.revision, expected.center.revision);
  }
});

test("split UTF-8 frame preserves multibyte text in both TLS directions", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture();
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
              nextAction: "split probe complete",
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
    /split probe complete/u,
  );
  assert.equal(sawUpload, true);
});

test("multi-path assignment produces a complete first snapshot and a scoped delta", { timeout: 30_000 }, async (t) => {
  const paths = ["tasks/task-fleet-fleet/a.md", "tasks/task-fleet-fleet/b.md"],
    fixture = await fleetFixture(paths);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    edgeRoot = path.join(fixture.root, "multi-edge");
  const firstSchemas: string[] = [],
    firstBodies = ["# A one\n", "# B one\n"],
    first = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot: edgeRoot,
      changes: paths.map((itemPath, index) => ({ path: itemPath, body: firstBodies[index]! })),
      onFrame: (frame) => firstSchemas.push(frame.schema),
    });
  assert.equal(first.replica.schema, "fleet.ack.result/v1");
  assert.ok(firstSchemas.includes("fleet.delta.begin/v1"));
  for (const [index, itemPath] of paths.entries())
    assert.equal(
      readFileSync(
        path.join(
          edgeRoot,
          "repos",
          fixture.assignment.repoId,
          "views",
          fixture.assignment.viewId,
          "cuts",
          String(first.center.revision),
          "files",
          itemPath,
        ),
        "utf8",
      ),
      firstBodies[index],
    );
  const base = await ledgerBase(fixture),
    secondSchemas: string[] = [],
    nextBody = `${firstBodies[1]}Second.\n`,
    second = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot: edgeRoot,
      changes: [{ path: paths[1]!, body: nextBody, baseBlobSha256: sha256Bytes(Buffer.from(firstBodies[1]!)) }],
      baseLedgerSha: base.ledger,
      onFrame: (frame) => secondSchemas.push(frame.schema),
    });
  assert.equal(second.replica.schema, "fleet.ack.result/v1");
  assert.ok(secondSchemas.includes("fleet.delta.begin/v1"));
  const workspaceRoot = path.join(fixture.root, "multi-workspace");
  assert.equal(applyFleetMirrorCut(edgeRoot, fixture.assignment.repoId, workspaceRoot, "pull").outcome, "applied");
  assert.equal(readFileSync(path.join(workspaceRoot, "harness", paths[0]!), "utf8"), firstBodies[0]);
  assert.equal(readFileSync(path.join(workspaceRoot, "harness", paths[1]!), "utf8"), nextBody);
});

test("more than 64 completed uploads remain bounded across center restart", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetFixture(),
    edgeRoot = path.join(fixture.root, "many-edge");
  t.after(() => fixture.close());
  let center = await fixture.center(),
    body = "",
    baseBlobSha256: string | null = null;
  await runFleetReplicaPullClient({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.slowAssignment.nodeId,
    credential: "machine-secret",
    assignmentId: fixture.slowAssignment.assignmentId,
    viewRoot: path.join(fixture.root, "slow-edge"),
    diskQuotaBytes: replicaQuota,
  });
  for (let index = 0; index < 66; index += 1) {
    body += `line-${index}\n`;
    const result = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot: edgeRoot,
      changes: [{ path: fixture.path, body, baseBlobSha256 }],
    });
    assert.equal(result.replica.outcome, "applied");
    baseBlobSha256 = sha256Bytes(Buffer.from(body));
    if (index === 0)
      await assert.rejects(
        runFleetReplicaPullClient({
          port: center.port,
          ca: fixture.cert,
          nodeId: fixture.slowAssignment.nodeId,
          credential: "machine-secret",
          assignmentId: fixture.slowAssignment.assignmentId,
          viewRoot: path.join(fixture.root, "slow-edge"),
          diskQuotaBytes: replicaQuota,
          beforeAck: () => {
            throw new Error("slow consumer disconnect");
          },
        }),
        /slow consumer/u,
      );
    if (index === 32) {
      await center.close();
      center = await fixture.center();
    }
  }
  const stale = center.status().replicas.find((row) => row.viewId === fixture.slowAssignment.viewId)!;
  assert.equal(stale.delivery, "snapshot_required");
  assert.notEqual(stale.lagMs, null);
  const schemas: string[] = [];
  await runFleetReplicaPullClient({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.slowAssignment.nodeId,
    credential: "machine-secret",
    assignmentId: fixture.slowAssignment.assignmentId,
    viewRoot: path.join(fixture.root, "slow-edge"),
    diskQuotaBytes: replicaQuota,
    onFrame: (frame) => schemas.push(frame.schema),
  });
  assert.equal(schemas.includes("fleet.snapshot.begin/v1"), true);
  assert.equal(center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.delivery, "current");
  assert.equal(
    (await fixture.host.run(fixture.assignment.repoId, { kind: "doc-show", path: fixture.path }, fixture.auth))
      .evidence,
    body,
  );
});

test(
  "production Fleet TLS entry sustains 3/10/32 Git-less edge processes across eight repos without duplicate writes",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await scaleFixture();
    t.after(() => fixture.close());
    const center = await fixture.center();
    for (const count of [3, 10, 32]) {
      const clients = fixture.clients.splice(0, count),
        before = fixture.commitCounts(),
        results = await Promise.all(
          clients.map((client, index) => runChild(fixture, center.port, client, Math.floor(index / 8) * 120)),
        );
      assert.equal(results.length, count);
      assert.equal(
        results.every((result) => result.ok && result.gitAbsent && result.replica.outcome === "applied"),
        true,
      );
      await Promise.all(
        results.map((result, index) =>
          waitForReceiptCommit(fixture.host, result.repoId, result.center.opId, clients[index]!.assignment),
        ),
      );
      const repoCuts = fixture
          .commitCounts()
          .map((row, index) => ({ repoId: row.repoId, commits: row.commits - before[index]!.commits })),
        materializedCommits = repoCuts.reduce((sum, row) => sum + row.commits, 0),
        touchedRepos = new Set(results.map((result) => result.repoId)).size,
        childWindows = results.map((result, index) => ({
          label: clients[index]!.label,
          repoId: result.repoId,
          startedAt: result.startedAt,
          endedAt: result.endedAt,
        })),
        evidence = `Fleet coalescing evidence: ${JSON.stringify({ count, materializedCommits, touchedRepos, repoCuts, childWindows })}`;
      t.diagnostic(evidence);
      assert.equal(materializedCommits >= touchedRepos, true, evidence);
      assert.equal(materializedCommits <= count, true, evidence);
      if (count > touchedRepos)
        assert.equal(
          materializedCommits < count,
          true,
          `${count} writes must coalesce into fewer Git cuts; ${evidence}`,
        );
      const intervalsOverlap = results.some((left, index) =>
        results
          .slice(index + 1)
          .some(
            (right) =>
              left.repoId !== right.repoId &&
              Math.max(left.startedAt, right.startedAt) < Math.min(left.endedAt, right.endedAt),
          ),
      );
      assert.equal(intervalsOverlap, true, "at least two repo transport/write windows must overlap");
      const readMs: number[] = [];
      for (const client of clients) {
        const started = performance.now(),
          shown = await fixture.host.run(
            client.assignment.repoId,
            { kind: "doc-show", path: client.path },
            { transportKind: "fleet-tls", assignmentBinding: client.assignment },
          );
        readMs.push(performance.now() - started);
        assert.equal(shown.evidence, client.body);
      }
      readMs.sort((a, b) => a - b);
      assert.ok(readMs[Math.ceil(readMs.length * 0.95) - 1]! < 2_000);
    }
  },
);

test("fixture teardown reclaims a still-running edge child and its TLS center", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetFixture();
  t.after(() => fixture.close());
  const center = await fixture.center(),
    bodyFile = path.join(fixture.root, "reclaim-body");
  writeFileSync(bodyFile, "# Reclaim\n");
  const pending = runFaultChild(fixture, {
    port: center.port,
    caFile: fixture.certFile,
    servername: "localhost",
    nodeId: fixture.assignment.nodeId,
    credential: "machine-secret",
    assignmentId: fixture.assignment.assignmentId,
    repoId: fixture.assignment.repoId,
    viewRoot: path.join(fixture.root, "reclaim-edge"),
    path: fixture.path,
    bodyFile,
    label: "reclaim",
    startDelayMs: 30_000,
  });
  await fixture.close();
  await assert.rejects(pending, /fault edge exited null/u);
  await assert.rejects(
    rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret"),
    /ECONNREFUSED/u,
  );
});

test(
  "remote-edge runtime launches locally while lifecycle and worker progress settle at center",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(["tasks/task-fleet-fleet"]);
    t.after(() => fixture.close());
    const taskReleaseBarrier = fixture.blockTaskRelease();
    t.after(taskReleaseBarrier.release);
    const center = await fixture.center(),
      edgeRoot = path.join(fixture.root, "runtime-edge"),
      edgeUserRoot = path.join(fixture.root, "runtime-edge-user"),
      viewRoot = path.join(fixture.root, "runtime-edge-view"),
      rosterPath = path.join(fixture.root, "runtime-roster.json"),
      uid = process.getuid?.() ?? 0,
      localAuth = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
      } as const;
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: fleet-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, fixture.assignment.repoId, edgeRoot, "pull");
    writeFileSync(
      rosterPath,
      `${JSON.stringify({ schema: "fleet-roster/v1", nodes: [{ nodeId: fixture.assignment.nodeId, credential: "machine-secret" }], assignments: [{ assignmentId: fixture.assignment.assignmentId, nodeId: fixture.assignment.nodeId, repoId: fixture.assignment.repoId, taskId: fixture.assignment.taskId, executionId: fixture.assignment.executionId, viewId: fixture.assignment.viewId, personId: fixture.assignment.actor.principal.personId, executorId: fixture.assignment.actor.executor?.id, expiresAt: fixture.assignment.expiresAt, paths: fixture.assignment.paths }] })}\n`,
    );
    registerDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.assignment.repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    const runtimeDefinition: AgentDefinitionSnapshot = {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "edge-codex",
        installationId: "edge-codex-installation",
        kindId: "codex",
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        baseUrl: null,
        authMode: "subscription",
      },
      alternateInstanceId = "aaa-edge-codex",
      runtimeInstallation: RuntimeInstallationWitness = {
        installationId: runtimeDefinition.installationId,
        kindId: runtimeDefinition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      unique = `edge-worker-${Date.now()}`,
      before = await fixture.host.read(fixture.assignment.repoId, "repo.tasks.list", {}, fixture.auth),
      launchedInstances: string[] = [];
    let launchedEnv: NodeJS.ProcessEnv | null = null;
    const edgeHost = await openDaemonHost({
      daemonId: "fleet-runtime-edge",
      userRoot: edgeUserRoot,
      runtimeDiscover: () => [runtimeInstallation],
      runtimeLaunch: (prepared) => {
        launchedEnv = prepared.env;
        const launchIndex = launchedInstances.push(prepared.definition.instanceId) - 1;
        let output: ((chunk: string) => void) | null = null,
          exit: ((code: number | null) => void) | null = null;
        return {
          pid: 90210 + launchIndex,
          onOutput: (listener) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            exit = listener;
            queueMicrotask(async () => {
              if (launchIndex === 0)
                await runFleetEdgeTask({
                  payload: {
                    host: "127.0.0.1",
                    port: center.port,
                    caPath: fixture.certFile,
                    nodeId: fixture.assignment.nodeId,
                    rosterPath,
                    assignmentId: fixture.assignment.assignmentId,
                    repoId: fixture.assignment.repoId,
                    viewRoot,
                    quotaBytes: replicaQuota,
                    workspaceRoot: edgeRoot,
                    action: {
                      kind: "task-progress-append",
                      taskId: fixture.assignment.taskId,
                      executionId: fixture.assignment.executionId,
                      text: unique,
                      evidence: [],
                    },
                  },
                });
              output?.(
                `${JSON.stringify({ type: "thread.started", thread_id: "edge-provider-session" })}\n${JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", status: "completed" } })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "edge runtime done" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
              );
              exit?.(0);
            });
          },
          terminate: () => undefined,
        };
      },
    });
    t.after(() => edgeHost.close());
    await edgeHost.attachmentsSettled();
    for (const [instanceId, name] of [
      [runtimeDefinition.instanceId, "Edge Codex"],
      [alternateInstanceId, "Alternate Codex"],
    ])
      await edgeHost.runtimeInstance(
        "daemon.runtimeInstance.create",
        {
          instanceId,
          name,
          kindId: runtimeDefinition.kindId,
          installationId: runtimeDefinition.installationId,
          providerId: runtimeDefinition.providerId,
          models: [runtimeDefinition.model],
          codex: { reasoningEffort: runtimeDefinition.reasoningEffort },
          authMode: runtimeDefinition.authMode,
        },
        localAuth,
      );
    const receipt = await edgeHost.fleet.edgeRuntime(
      {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.assignment.nodeId,
        rosterPath,
        assignmentId: fixture.assignment.assignmentId,
        repoId: fixture.assignment.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: {
          runtimeInstanceId: runtimeDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Append one progress checkpoint.",
          taskId: fixture.assignment.taskId,
          idempotencyKey: "remote-edge-runtime",
        },
      },
      localAuth,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(launchedEnv?.HARNESS_DAEMON_USER_ROOT, edgeUserRoot);
    assert.equal(launchedEnv?.HARNESS_DAEMON_ID, "fleet-runtime-edge");
    assert.equal(launchedEnv?.HARNESS_DAEMON_REPO_ID, fixture.assignment.repoId);
    await taskReleaseBarrier.started;
    await delay(5_100);
    const settlingEvents = makeTaskEventStore({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
      .read()
      .events.filter(
        (event) =>
          (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
          event.payload.runtimeSessionId === receipt.runtimeSessionId,
      );
    assert.deepEqual(settlingEvents, [], "edge must not publish exited while center settlement is pending");
    taskReleaseBarrier.release();
    const waitForOutcome = async (runtimeSessionId: unknown) => {
      const deadline = Date.now() + 20_000;
      let status: Awaited<ReturnType<typeof fixture.host.read>> | null = null;
      do {
        try {
          const candidate = await fixture.host.read(
            fixture.assignment.repoId,
            "repo.agentRuntime.sessions.read",
            { runtimeSessionId },
            fixture.auth,
          );
          if (candidate.session.activity.outcome !== null) return candidate;
        } catch {
          status = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return status;
    };
    assert.equal((await waitForOutcome(receipt.runtimeSessionId))?.session.activity.outcome, "succeeded");
    const settledEvents = makeTaskEventStore({ repoId: fixture.assignment.repoId, rootDir: fixture.repo }).read()
        .events,
      leaseReleaseIndex = settledEvents.findIndex(
        (event) => event.type === "lease_released" && event.taskId === fixture.assignment.taskId,
      ),
      runtimeExitIndex = settledEvents.findIndex(
        (event) =>
          event.type === "runtime_session_exited" && event.payload.runtimeSessionId === receipt.runtimeSessionId,
      ),
      runtimeOutcomeIndex = settledEvents.findIndex(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === receipt.runtimeSessionId,
      );
    assert.ok(
      leaseReleaseIndex < runtimeExitIndex && runtimeExitIndex < runtimeOutcomeIndex,
      "center settlement must precede the adjacent edge exit and outcome events",
    );
    const after = await fixture.host.read(fixture.assignment.repoId, "repo.tasks.list", {}, fixture.auth);
    assert.ok(after.sourceRevision > before.sourceRevision);
    await t.test("provider session resume keeps the center-observed runtime instance", async () => {
      const resumed = await edgeHost.fleet.edgeRuntime(
        {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId: fixture.assignment.nodeId,
          rosterPath,
          assignmentId: fixture.assignment.assignmentId,
          repoId: fixture.assignment.repoId,
          viewRoot,
          quotaBytes: replicaQuota,
          workspaceRoot: edgeRoot,
          method: "repo.agentRuntime.spawn",
          action: {
            providerSessionId: "edge-provider-session",
            cwd: { scope: "repo-root" },
            prompt: "Resume on the original runtime instance.",
            taskId: fixture.assignment.taskId,
            idempotencyKey: "remote-edge-runtime-resume",
          },
        },
        localAuth,
      );
      assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
      assert.equal((await waitForOutcome(resumed.runtimeSessionId))?.session.activity.outcome, "succeeded");
      assert.equal(launchedInstances.at(-1), runtimeDefinition.instanceId);
    });
    await t.test("another assignment cannot replay terminal events for this runtime session", async () => {
      const foreignAssignment = {
          ...fixture.assignment,
          nodeId: "node-two",
          assignmentId: "assignment-two",
          viewId: "node-two_task-fleet",
        },
        events = makeTaskEventStore({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
          .read()
          .events.filter(
            (event) =>
              (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          );
      assert.equal(events.length, 2);
      for (const event of events)
        await assert.rejects(
          fixture.host.runtimeIngress(
            fixture.assignment.repoId,
            { kind: "event", type: event.type, payload: event.payload, opId: event.opId },
            { transportKind: "fleet-tls", assignmentBinding: foreignAssignment },
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "assignment_scope_mismatch",
        );
    });
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, fixture.assignment.repoId, edgeRoot, "pull");
    const mirrored = locateFleetMirrorView(viewRoot, fixture.assignment.repoId);
    assert.ok(mirrored);
    assert.equal(
      (
        readFileSync(path.join(edgeRoot, "harness/tasks/task-fleet-fleet/progress.md"), "utf8").match(
          new RegExp(unique, "gu"),
        ) ?? []
      ).length,
      1,
    );
    assert.equal(existsSync(path.join(edgeRoot, ".harness/runtime/dispatches", `${receipt.dispatchId}.jsonl`)), true);
    assert.equal(
      existsSync(path.join(fixture.repo, ".harness/runtime/dispatches", `${receipt.dispatchId}.jsonl`)),
      false,
    );
  },
);

test("fleet runtime waits over five seconds for every configured overview page", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture();
  t.after(() => fixture.close());
  const definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "slow-page-codex",
      installationId: "slow-page-installation",
      kindId: "codex",
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    template: AgentRuntimeSessionDto = {
      runtimeSessionId: "runtime-slow-00",
      providerSessionId: null,
      instanceId: definition.instanceId,
      installationId: definition.installationId,
      kindId: definition.kindId,
      definitionSnapshotRef: "artifact:runtime-definition/slow-page",
      definitionSnapshot: definition,
      liveness: "live",
      semanticState: "running",
      attachCapability: "supported",
      streamCursor: "stream:0",
      associations: [],
      activity: {
        lastObservedAt: "2026-08-24T12:00:00.000Z",
        outcome: null,
        exitCode: null,
        resultRef: null,
      },
    },
    sessions = Array.from({ length: 17 }, (_, index) => ({
      ...template,
      runtimeSessionId: `runtime-slow-${String(index).padStart(2, "0")}`,
    })),
    pagePayloads: Array<Record<string, unknown>> = [],
    responseWaits: number[] = [];
  const slowHost = {
    ...fixture.host,
    read: async (...args: Parameters<typeof fixture.host.read>) => {
      const [repoId, method, payload, auth] = args;
      if (method !== "repo.agentRuntime.overview") return fixture.host.read(repoId, method, payload, auth);
      const startedAt = performance.now();
      await delay(5_100);
      responseWaits.push(performance.now() - startedAt);
      const query = payload as Record<string, unknown>,
        limit = Number(query.limit),
        cursor = typeof query.cursor === "string" ? query.cursor : null,
        start = cursor === null ? 0 : Number(cursor.slice("slow-page:".length)),
        selected = sessions.slice(start, start + limit),
        next = start + selected.length;
      pagePayloads.push(query);
      return {
        ok: true,
        status: "ready",
        installations: [],
        instances: [],
        sessions: selected,
        page: {
          limit,
          cursor,
          nextCursor: next < sessions.length ? `slow-page:${next}` : null,
          remainingCount: Math.max(0, sessions.length - next),
        },
        watermark: 1,
        sourceRevision: 1,
      };
    },
  };
  const center = await listenFleetTls({
    host: slowHost,
    stateRoot: path.join(fixture.root, "slow-runtime-center"),
    key: fixture.key,
    cert: fixture.cert,
    replicaDiskQuotaBytes: replicaQuota,
    authenticate: (nodeId, credential) => nodeId === fixture.assignment.nodeId && credential === "machine-secret",
    resolveAssignment: (assignmentId) => (assignmentId === fixture.assignment.assignmentId ? fixture.assignment : null),
  });
  t.after(() => center.close());
  const workspaceRoot = path.join(fixture.root, "slow-runtime-edge"),
    viewRoot = path.join(fixture.root, "slow-runtime-view");
  mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: slow-runtime-edge\n" +
      "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(workspaceRoot, "fleet-edge.json"),
    `${JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: fixture.assignment.repoId,
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot,
      quotaBytes: replicaQuota,
      waitTimeoutMs: 6_200,
    })}\n`,
  );
  const runtime = openFleetEdgeRuntime({
    request: {
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      repoId: fixture.assignment.repoId,
      viewRoot,
      quotaBytes: replicaQuota,
      workspaceRoot,
      method: "repo.agentRuntime.overview",
      action: { limit: 1 },
    },
    daemonGeneration: 1,
    daemonRoute: {
      userRoot: path.join(fixture.root, "slow-runtime-user"),
      daemonId: "slow-runtime-edge",
      endpoint: path.join(fixture.root, "slow-runtime.sock"),
    },
    ports: {
      runtimeInstances: () => [],
      prepareRuntimeLaunch: async () => {
        throw new Error("runtime launch is not part of the read test");
      },
    },
  });
  t.after(() => runtime.close());
  const overview = await runtime.run("repo.agentRuntime.overview", { limit: 1 });
  assert.equal((overview.sessions as readonly unknown[]).length, 1);
  assert.deepEqual(pagePayloads.slice(0, 2), [{ limit: 16 }, { limit: 16, cursor: "slow-page:16" }]);
  assert.equal(responseWaits.length, 3);
  assert.equal(
    responseWaits.every((elapsed) => elapsed >= 5_000),
    true,
  );
});

test(
  "production Fleet session rejects provenance, revocation, expiry, content mismatch, and ninth active upload before L1",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture();
    t.after(() => fixture.close());
    const center = await fixture.center(),
      before = fixture.commitCount();
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
    assert.equal(fixture.commitCount(), before);
  },
);

test(
  "disconnect and crash recovery preserve upload/view/ACK idempotency while an unacked replica never holds the repo mutex",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(),
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
    const initial = fixture.commitCount();
    assert.equal((await runFaultChild(fixture, { ...base, killAfterPartialUpload: true })).code, 74);
    assert.equal(fixture.commitCount(), initial);
    assert.ok(Number(readFileSync(markerFile, "utf8")) > 0);
    rmSync(markerFile, { force: true });
    await center.close();
    center = await fixture.center();
    base = { ...base, port: center.port };
    assert.equal((await runFaultChild(fixture, { ...base, killOnSchema: "fleet.upload.result/v1" })).code, 73);
    assert.equal(fixture.commitCount(), initial);
    rmSync(markerFile, { force: true });
    const first = await runFaultChild(fixture, base);
    assert.equal(first.code, 0);
    await waitForCommitCount(fixture, initial + 1);
    const firstCut = center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      secondBody = `${firstBody}second\n`,
      secondBase = await ledgerBase(fixture);
    writeFileSync(bodyFile, secondBody);
    const beforeSecond = fixture.commitCount();
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
    await waitForCommitCount(fixture, beforeSecond + 1);
    assert.equal(
      center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      firstCut,
    );
    const status = await Promise.race([
      fixture.host.run(fixture.assignment.repoId, { kind: "doc-status", paths: [fixture.path] }, fixture.auth),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("RepoCell waited for replica ACK")), 500)),
    ]);
    assert.equal(status.outcome, "applied");
    const probe = await fixture.host.run(
      fixture.assignment.repoId,
      { kind: "task-create", taskId: "task-hol-probe", title: "HOL probe" },
      fixture.auth,
    );
    assert.equal(probe.outcome, "applied");
    await waitForReceiptCommit(fixture.host, fixture.assignment.repoId, probe.opId, fixture.assignment);
    const afterProbe = fixture.commitCount();
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
    assert.equal(fixture.commitCount(), afterProbe);
    const thirdBody = `${secondBody}third\n`,
      thirdBase = await ledgerBase(fixture);
    writeFileSync(bodyFile, thirdBody);
    const beforeThird = fixture.commitCount();
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
    await waitForCommitCount(fixture, beforeThird + 1);
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
    assert.equal(fixture.commitCount(), beforeThird + 1);
    const fourthBody = `${thirdBody}fourth\n`,
      fourthBase = await ledgerBase(fixture);
    writeFileSync(bodyFile, fourthBody);
    const beforeFourth = fixture.commitCount();
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
    await waitForCommitCount(fixture, beforeFourth + 1);
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
    assert.equal(fixture.commitCount(), beforeFourth + 1);
    assert.equal(
      center.status().replicas.find((row) => row.viewId === fixture.assignment.viewId)?.ackRevision,
      ackedBeforeRetry,
    );
  },
);

async function fleetFixture(paths: readonly string[] = ["tasks/task-fleet-fleet/notes.md"]) {
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
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(emptyPath);
  initRepo(repo);
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: fleet\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
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
  assert.equal(
    (await host.run(assignment.repoId, { kind: "task-create", taskId: assignment.taskId, title: "Fleet" }, auth))
      .outcome,
    "applied",
  );
  const started = await host.run(
    assignment.repoId,
    { kind: "task-start", taskId: assignment.taskId, executionId: assignment.executionId },
    auth,
  );
  assert.equal(started.outcome, "applied");
  await waitForReceiptCommit(host, assignment.repoId, started.opId, assignment);
  return {
    root,
    repo,
    stateRoot,
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
    commitCount: () => Number(git(repo, "rev-list", "--count", "refs/ha/canonical")),
    center: () =>
      owned.hold(
        listenFleetTls({
          host: {
            ...host,
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

type ScaleClient = { assignment: FleetAssignmentRecord; path: string; body: string; label: string };
async function scaleFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-scale-")),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path"),
    owned = reclaimer();
  mkdirSync(emptyPath);
  const repos = Array.from({ length: 8 }, (_, index) => ({
    repoId: `fleet-r${index}`,
    rootDir: path.join(root, `repo-${index}`),
  }));
  for (const repo of repos) {
    mkdirSync(path.join(repo.rootDir, "harness"), { recursive: true });
    initRepo(repo.rootDir);
    writeFileSync(
      path.join(repo.rootDir, "harness/harness.yaml"),
      `schema: harness-anything/v1\nname: ${repo.repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
    );
    git(repo.rootDir, "add", "harness");
    git(repo.rootDir, "commit", "-qm", "harness");
    registerDaemonRepo({ canonicalRoot: repo.rootDir, repoId: repo.repoId, userRoot, createConvenienceLinks: false });
  }
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
  const host = await openDaemonHost({ daemonId: "fleet-scale", userRoot }),
    clients: ScaleClient[] = [],
    assignments = new Map<string, FleetAssignmentRecord>();
  await host.attachmentsSettled();
  const setupCuts = new Map<string, { readonly opId: string; readonly assignment: FleetAssignmentRecord }>();
  for (let index = 0; index < 45; index += 1) {
    const repo = repos[index % repos.length]!,
      taskId = `task-f${index}`,
      assignment: FleetAssignmentRecord = {
        nodeId: `node-${index}`,
        assignmentId: `assignment-${index}`,
        repoId: repo.repoId,
        taskId,
        executionId: `execution-${index}`,
        paths: [`tasks/${taskId}-${taskId}/notes.md`],
        viewId: `view-${index}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: { principal: { personId: "fleet-owner" }, executor: { kind: "agent", id: `edge-${index}` } },
      },
      auth = { transportKind: "fleet-tls" as const, assignmentBinding: assignment };
    assignments.set(assignment.assignmentId, assignment);
    assert.equal(
      (await host.run(repo.repoId, { kind: "task-create", taskId, title: taskId }, auth)).outcome,
      "applied",
    );
    const started = await host.run(
      repo.repoId,
      { kind: "task-start", taskId, executionId: assignment.executionId },
      auth,
    );
    assert.equal(started.outcome, "applied");
    setupCuts.set(repo.repoId, { opId: started.opId, assignment });
    clients.push({
      assignment,
      path: assignment.paths[0]!,
      body: `# ${taskId}\n\nbody-${index}\n`,
      label: `client-${index}`,
    });
  }
  await Promise.all(
    [...setupCuts].map(([repoId, value]) => waitForReceiptCommit(host, repoId, value.opId, value.assignment)),
  );
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile);
  return {
    root,
    host,
    certFile,
    emptyPath,
    clients,
    track: owned.track,
    center: () =>
      owned.hold(
        listenFleetTls({
          host,
          stateRoot,
          key,
          cert,
          replicaDiskQuotaBytes: replicaQuota,
          authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
          resolveAssignment: (assignmentId) => assignments.get(assignmentId) ?? null,
        }),
      ),
    commitCounts: () =>
      repos.map((repo) => ({
        repoId: repo.repoId,
        commits: Number(git(repo.rootDir, "rev-list", "--count", "refs/ha/canonical")),
      })),
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function crossRepoFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-cross-repo-")),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    pathValue = "tasks/task-cross-cross/notes.md",
    owned = reclaimer(),
    repos = ["repo-a", "repo-b"].map((repoId) => ({ repoId, rootDir: path.join(root, repoId) }));
  for (const repo of repos) {
    mkdirSync(path.join(repo.rootDir, "harness"), { recursive: true });
    initRepo(repo.rootDir);
    writeFileSync(
      path.join(repo.rootDir, "harness/harness.yaml"),
      `schema: harness-anything/v1\nname: ${repo.repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
    );
    git(repo.rootDir, "add", "harness");
    git(repo.rootDir, "commit", "-qm", "harness");
    registerDaemonRepo({ canonicalRoot: repo.rootDir, repoId: repo.repoId, userRoot, createConvenienceLinks: false });
  }
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
  const host = await openDaemonHost({ daemonId: "fleet-cross-repo", userRoot }),
    assignments: FleetAssignmentRecord[] = repos.map((repo, index) => ({
      nodeId: "node-shared",
      assignmentId: `assignment-${index}`,
      repoId: repo.repoId,
      taskId: "task-cross",
      executionId: "execution-cross",
      paths: [pathValue],
      viewId: "view-shared",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "fleet-edge" } },
    }));
  await host.attachmentsSettled();
  for (const assignment of assignments) {
    const auth = { transportKind: "fleet-tls" as const, assignmentBinding: assignment };
    assert.equal(
      (await host.run(assignment.repoId, { kind: "task-create", taskId: assignment.taskId, title: "Cross" }, auth))
        .outcome,
      "applied",
    );
    assert.equal(
      (
        await host.run(
          assignment.repoId,
          { kind: "task-start", taskId: assignment.taskId, executionId: assignment.executionId },
          auth,
        )
      ).outcome,
      "applied",
    );
  }
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile),
    byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
  return {
    root,
    cert,
    assignments,
    path: pathValue,
    track: owned.track,
    center: () =>
      owned.hold(
        listenFleetTls({
          host,
          stateRoot,
          key,
          cert,
          replicaDiskQuotaBytes: replicaQuota,
          authenticate: (nodeId, credential) => nodeId === "node-shared" && credential === "machine-secret",
          resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null,
        }),
      ),
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
// Edge children report their result on stdout, so both runners settle on `close`, not `exit`:
// `exit` fires when the process ends and can precede the last stdout chunk, which under a
// 32-way fan-out leaves the parent parsing a truncated line.
function runChild(
  fixture: Awaited<ReturnType<typeof scaleFixture>>,
  port: number,
  client: ScaleClient,
  startDelayMs: number,
): Promise<{
  ok: boolean;
  gitAbsent: boolean;
  repoId: string;
  startedAt: number;
  endedAt: number;
  center: { opId: string };
  replica: { outcome: string };
}> {
  const directory = path.join(fixture.root, "children", client.label);
  mkdirSync(directory, { recursive: true });
  const bodyFile = path.join(directory, "body"),
    configFile = path.join(directory, "config.json");
  writeFileSync(bodyFile, client.body);
  writeFileSync(
    configFile,
    JSON.stringify({
      port,
      caFile: fixture.certFile,
      servername: "localhost",
      nodeId: client.assignment.nodeId,
      credential: `secret-${client.assignment.nodeId}`,
      assignmentId: client.assignment.assignmentId,
      repoId: client.assignment.repoId,
      viewRoot: path.join(directory, "view"),
      path: client.path,
      bodyFile,
      retry: true,
      label: client.label,
      startDelayMs,
    }),
  );
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
      if (code !== 0) reject(new Error(`edge ${client.label} exited ${code}: ${errors}`));
      else
        try {
          resolve(JSON.parse(output.trim()));
        } catch (error) {
          reject(error);
        }
    });
  });
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
async function waitForCommitCount(fixture: Awaited<ReturnType<typeof fleetFixture>>, expected: number): Promise<void> {
  const deadline = performance.now() + 15_000;
  do {
    if (fixture.commitCount() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  assert.equal(fixture.commitCount(), expected, "Git materialization did not reach the expected bounded cut");
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
