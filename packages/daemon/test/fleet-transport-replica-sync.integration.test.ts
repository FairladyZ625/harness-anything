// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  fleetHostWriterOptions,
  fleetLedgerRevision,
  fleetNodeOwners,
  waitForFleetPublication,
} from "./fleet-store.fixture.ts";
import { setTimeout as delay } from "node:timers/promises";
import { READ_MODEL_SCHEMA_GENERATION, sha256Bytes, type LedgerCutIdentity } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { readHeadConfirmation } from "../src/fleet/replica-read-model.ts";
import { listenFleetTls, type FleetTlsCenter } from "../src/fleet/center.ts";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";
import {
  readFleetRepositoryMetadataClient,
  runFleetReplicaPullClient,
  runFleetWriteClient,
  type FleetReplicaPullClientOptions,
  type FleetWriteClientOptions,
} from "../src/fleet/edge.ts";
import { FleetReplicaSessionPool, runFleetReplicaSync } from "../src/fleet/edge-replica-sync.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { type FleetCut } from "../src/fleet/contract.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
type FleetTestSubject = {
  nodeId: string;
  repoId: string;
  taskId: string;
  executionId: string;
  paths: readonly string[];
  viewId: string;
};

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
test("cross-repo transfer identity keeps equal node/view/cut/digest isolated", { timeout: 30_000 }, async (t) => {
  const fixture = await crossRepoFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center();
  const edgeRoot = path.join(fixture.root, "edge"),
    body = "# Same cut\n",
    first = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subjects[0]!.nodeId,
      credential: "machine-secret",
      repoId: fixture.subjects[0]!.repoId,
      executionId: fixture.subjects[0]!.executionId,
      viewRoot: edgeRoot,
      changes: [{ path: fixture.path, body }],
    });
  const second = await runFleetRoundTrip({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.subjects[1]!.nodeId,
    credential: "machine-secret",
    repoId: fixture.subjects[1]!.repoId,
    executionId: fixture.subjects[1]!.executionId,
    viewRoot: edgeRoot,
    changes: [{ path: fixture.path, body }],
  });
  assert.equal(first.center.revision, second.center.revision);
  assert.notEqual(first.center.opId, second.center.opId);
  for (const [index, subject] of fixture.subjects.entries()) {
    const expected = index === 0 ? first : second,
      receipt = center.replicaReceipt(expected.center.opId, subject.nodeId, subject.viewId, subject.repoId),
      current = JSON.parse(
        readFileSync(path.join(edgeRoot, "repos", subject.repoId, "views", subject.viewId, "current.json"), "utf8"),
      ) as { cut: FleetCut };
    assert.equal(receipt.opId, expected.center.opId);
    assert.equal(receipt.outcome, "applied");
    assert.equal(current.cut.revision, expected.center.revision);
  }
});

const backgroundPaths = ["tasks/task-fleet-fleet/a.md", "tasks/task-fleet-fleet/b.md"];
test("a node's next pull retires its frozen legacy view row from the center ledger", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  // 测试床 B2 的传输层复现:S8 前静态 assignment 时代的旧 view 行冻结在中心台账里,节点
  // 已改用 nodeId 命名的新 view 拉取。先在 listener 启动前把残迹种进 ack store。
  const legacy = { nodeId: "node-one", viewId: "node-one-schedule-view", repoId: fixture.subject.repoId },
    legacyCut = {
      revision: 5,
      headDigest: `sha256:${"a".repeat(64)}`,
      schemaGeneration: READ_MODEL_SCHEMA_GENERATION,
    },
    legacyDigest = "b".repeat(64),
    seed = openReplicaAckStore(fixture.stateRoot);
  seed.register(legacy, 3);
  const legacyLease = seed.delivery.claim(legacy, "holder-legacy", Date.parse("2026-10-05T00:00:00.000Z"), 30_000)!;
  seed.offer(legacy, {
    transferId: "transfer-legacy",
    fromCut: null,
    toCut: legacyCut,
    manifestDigest: legacyDigest,
    kind: "snapshot",
    issuedAt: "2026-10-05T00:00:00.000Z",
  });
  assert.equal(
    seed.ack(
      legacy,
      "transfer-legacy",
      legacyCut,
      legacyDigest,
      "2026-10-05T00:00:01.000Z",
      "2026-10-04T00:00:00.000Z",
      legacyLease,
    ).outcome,
    "applied",
  );
  seed.close();

  const center = await fixture.center();
  // 症状:退役 view 仍出现在中心 status(它正是 fleet overview 节点卡/links 的数据源),
  // 带着 seed 时的最后一次 ack。repo 首次 pull 前 cut source 未激活,delivery 如实 degraded。
  const before = center.status().replicas.find((row) => row.viewId === legacy.viewId)!;
  assert.equal(before.ackRevision, 5);

  await runFleetReplicaPullClient({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.subject.nodeId,
    credential: "machine-secret",
    repoId: fixture.subject.repoId,
    viewRoot: path.join(fixture.root, "edge"),
    diskQuotaBytes: replicaQuota,
  });
  // 节点带着新 view 完成一次 pull(snapshot 传输 + ACK 落定)后,退役 view 被回收,
  // 节点只剩活跃 view 的 current 行。
  const rows = center.status().replicas.filter((row) => row.nodeId === fixture.subject.nodeId);
  assert.deepEqual(
    rows.map((row) => [row.viewId, row.delivery, row.lagRevisions]),
    [[fixture.subject.viewId, "current", 0]],
  );
});

test("background replica sync follows a new center cut without a read request", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t, backgroundPaths);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    edgeRoot = path.join(fixture.root, "background-edge"),
    peer = {
      hostname: "127.0.0.1",
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
    },
    first = await centerWrite(peer, fixture.subject.executionId, backgroundPaths[0]!, "# first\n"),
    sync = syncProbe(),
    controller = new AbortController(),
    running = runFleetReplicaSync({
      ...peer,
      viewRoot: edgeRoot,
      diskQuotaBytes: replicaQuota,
      signal: controller.signal,
      onConfirmed: sync.pulled,
      onFailure: sync.failed,
      schedule: () => assert.fail("no failure is expected, so no reconnect is scheduled"),
    });
  await sync.until(() => sync.revisions.includes(first));
  // The edge now waits on the center; the center moves on and the edge issues no read of its own.
  const next = await centerWrite(peer, fixture.subject.executionId, backgroundPaths[1]!, "# second\n");
  await sync.until(() => sync.revisions.includes(next));
  controller.abort();
  await running;
  assert.deepEqual(sync.failures, []);
  assert.equal(edgeCurrent(edgeRoot, fixture.subject).revision, next);
  assert.equal(edgeCutFile(edgeRoot, fixture.subject, next, backgroundPaths[1]!), "# second\n");
});
test(
  "background replica sync drops a dead pooled session and catches up after a center restart",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t, backgroundPaths);
    t.after(() => fixture.close());
    const center = await fixture.center();
    const port = center.port,
      edgeRoot = path.join(fixture.root, "restart-edge"),
      peer = {
        hostname: "127.0.0.1",
        port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
      },
      // Idle sessions never expire on their own here: a dead session must leave the pool because its use failed.
      sessionPool = new FleetReplicaSessionPool({ schedule: () => ({}) as NodeJS.Timeout, cancel: () => {} }),
      reconnects: Array<{ readonly run: () => void; readonly delayMs: number }> = [],
      sync = syncProbe(),
      controller = new AbortController();
    t.after(() => sessionPool.close());
    const first = await centerWrite(peer, fixture.subject.executionId, backgroundPaths[0]!, "# first\n"),
      running = runFleetReplicaSync({
        ...peer,
        viewRoot: edgeRoot,
        diskQuotaBytes: replicaQuota,
        sessionPool,
        signal: controller.signal,
        retryDelaysMs: [5, 15, 60],
        onConfirmed: sync.pulled,
        onFailure: sync.failed,
        schedule: (run, delayMs) => {
          reconnects.push({ run, delayMs });
          sync.notify();
        },
      });
    await sync.until(() => sync.revisions.includes(first));
    await center.close();
    await sync.until(() => reconnects.length === 1);
    // Back on the same address, with a cut the edge has never seen.
    await fixture.center(port);
    const next = await centerWrite(peer, fixture.subject.executionId, backgroundPaths[1]!, "# second\n");
    reconnects[0]!.run();
    await sync.until(() => sync.revisions.includes(next));
    controller.abort();
    await running;
    assert.equal(sync.failures.length, 1, `failures: ${sync.failures.map(String).join("; ")}`);
    assert.deepEqual(
      reconnects.map(({ delayMs }) => delayMs),
      [5],
    );
    assert.equal(edgeCurrent(edgeRoot, fixture.subject).revision, next);
    assert.equal(edgeCutFile(edgeRoot, fixture.subject, next, backgroundPaths[1]!), "# second\n");
  },
);
test("an idle center keeps a watching edge confirmed fresh without another pull", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t, backgroundPaths);
  t.after(() => fixture.close());
  // A short progress interval stands in for the 20s default; the test itself waits only on reported events.
  const center = await fixture.center(undefined, 300),
    edgeRoot = path.join(fixture.root, "progress-edge"),
    peer = {
      hostname: "127.0.0.1",
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
    },
    head = await centerWrite(peer, fixture.subject.executionId, backgroundPaths[0]!, "# first\n"),
    sync = syncProbe(),
    controller = new AbortController();
  let pulls = 0;
  const running = runFleetReplicaSync({
    ...peer,
    viewRoot: edgeRoot,
    diskQuotaBytes: replicaQuota,
    signal: controller.signal,
    onConfirmed: sync.pulled,
    onFailure: sync.failed,
    onFrame: (frame) => {
      if (frame.schema === "fleet.replica.current/v1") pulls += 1;
    },
    schedule: () => assert.fail("no failure is expected, so no reconnect is scheduled"),
  });
  await sync.until(() => sync.revisions.length >= 1);
  const viewDir = path.join(edgeRoot, "repos", fixture.subject.repoId, "views", fixture.subject.viewId),
    firstConfirmed = readHeadConfirmation(viewDir)!.confirmedAt;
  await sync.until(() => sync.revisions.length >= 3);
  controller.abort();
  await running;
  assert.deepEqual(sync.revisions, [head, head, head].concat(sync.revisions.slice(3)));
  assert.equal(pulls, 1, "unchanged heads are confirmed on the watch, not by pulling again");
  assert.ok(readHeadConfirmation(viewDir)!.confirmedAt > firstConfirmed);
  assert.deepEqual(sync.failures, []);
});
/** Event-driven view of a sync loop: tests wait on what the loop reports, never on a clock. */
function syncProbe() {
  const revisions: number[] = [],
    failures: unknown[] = [];
  let wake = (): void => {};
  const notify = () => wake();
  return {
    revisions,
    failures,
    notify,
    pulled: (revision: number) => {
      revisions.push(revision);
      notify();
    },
    failed: (error: unknown) => {
      failures.push(error);
      notify();
    },
    until: (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (ready()) resolve();
          else wake = check;
        };
        check();
      }),
  };
}
async function centerWrite(
  peer: Parameters<typeof readFleetRepositoryMetadataClient>[0],
  executionId: string,
  docPath: string,
  body: string,
): Promise<number> {
  const write = await runFleetWriteClient({
    ...peer,
    executionId,
    channel: "replica",
    changes: [{ path: docPath, body }],
  });
  assert.equal(write.center.outcome, "applied", JSON.stringify(write.center));
  await waitForCenterLedgerRevision(peer, write.center.revision!, 5_000);
  return write.center.revision!;
}
function edgeCurrent(edgeRoot: string, subject: FleetTestSubject): FleetCut {
  return (
    JSON.parse(
      readFileSync(path.join(edgeRoot, "repos", subject.repoId, "views", subject.viewId, "current.json"), "utf8"),
    ) as { cut: FleetCut }
  ).cut;
}
function edgeCutFile(edgeRoot: string, subject: FleetTestSubject, revision: number, docPath: string): string {
  return readFileSync(
    path.join(
      edgeRoot,
      "repos",
      subject.repoId,
      "views",
      subject.viewId,
      "cuts",
      `${revision}-g${READ_MODEL_SCHEMA_GENERATION}`,
      "files",
      docPath,
    ),
    "utf8",
  );
}
test("multi-path subject produces a complete first snapshot and a scoped delta", { timeout: 30_000 }, async (t) => {
  const paths = ["tasks/task-fleet-fleet/a.md", "tasks/task-fleet-fleet/b.md"],
    fixture = await fleetFixture(t, paths);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    edgeRoot = path.join(fixture.root, "multi-edge");
  const firstSchemas: string[] = [],
    firstBodies = ["# A one\n", "# B one\n"],
    first = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      executionId: fixture.subject.executionId,
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
          fixture.subject.repoId,
          "views",
          fixture.subject.viewId,
          "cuts",
          `${first.center.revision}-g${READ_MODEL_SCHEMA_GENERATION}`,
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
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      executionId: fixture.subject.executionId,
      viewRoot: edgeRoot,
      changes: [{ path: paths[1]!, body: nextBody, baseBlobSha256: sha256Bytes(Buffer.from(firstBodies[1]!)) }],
      baseLedgerSha: base.ledger,
      onFrame: (frame) => secondSchemas.push(frame.schema),
    });
  assert.equal(second.replica.schema, "fleet.ack.result/v1");
  assert.ok(secondSchemas.includes("fleet.delta.begin/v1"));
  const workspaceRoot = path.join(fixture.root, "multi-workspace");
  assert.equal(applyFleetMirrorCut(edgeRoot, fixture.subject.repoId, workspaceRoot, "pull").outcome, "applied");
  assert.equal(readFileSync(path.join(workspaceRoot, "harness", paths[0]!), "utf8"), firstBodies[0]);
  assert.equal(readFileSync(path.join(workspaceRoot, "harness", paths[1]!), "utf8"), nextBody);
});
test("more than 64 completed uploads remain bounded across center restart", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetFixture(t),
    edgeRoot = path.join(fixture.root, "many-edge");
  t.after(() => fixture.close());
  let center = await fixture.center(),
    body = "",
    baseBlobSha256: string | null = null;
  await runFleetReplicaPullClient({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.slowSubject.nodeId,
    credential: "machine-secret",
    repoId: fixture.slowSubject.repoId,
    viewRoot: path.join(fixture.root, "slow-edge"),
    diskQuotaBytes: replicaQuota,
  });
  for (let index = 0; index < 66; index += 1) {
    body += `line-${index}\n`;
    const result = await runFleetRoundTrip({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      executionId: fixture.subject.executionId,
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
          nodeId: fixture.slowSubject.nodeId,
          credential: "machine-secret",
          repoId: fixture.slowSubject.repoId,
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
  const stale = center.status().replicas.find((row) => row.viewId === fixture.slowSubject.viewId)!;
  assert.equal(stale.delivery, "snapshot_required");
  assert.notEqual(stale.lagMs, null);
  const schemas: string[] = [];
  await runFleetReplicaPullClient({
    port: center.port,
    ca: fixture.cert,
    nodeId: fixture.slowSubject.nodeId,
    credential: "machine-secret",
    repoId: fixture.slowSubject.repoId,
    viewRoot: path.join(fixture.root, "slow-edge"),
    diskQuotaBytes: replicaQuota,
    onFrame: (frame) => schemas.push(frame.schema),
  });
  assert.equal(schemas.includes("fleet.snapshot.begin/v1"), true);
  assert.equal(center.status().replicas.find((row) => row.viewId === fixture.subject.viewId)?.delivery, "current");
  assert.equal(
    (await fixture.host.run(fixture.subject.repoId, { kind: "doc-show", path: fixture.path }, fixture.auth)).evidence,
    body,
  );
});
async function fleetFixture(t: TestContext, paths: readonly string[] = ["tasks/task-fleet-fleet/notes.md"]) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-one-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path"),
    owned = reclaimer();
  let ownerLookupDelayMs = 0,
    taskReleaseBarrier: { readonly started: () => void; readonly wait: Promise<void> } | null = null;
  const runtimeArchiveReceipts: Readonly<Record<string, unknown>>[] = [];
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile),
    host = await openDaemonHost({ daemonId: "fleet-center", userRoot }),
    owners = await fleetNodeOwners({
      userRoot,
      owners: { "node-one": "person-owner", "node-slow": "person-owner" },
      repoIds: ["fleet-repo"],
    });
  t.after(async () => {
    try {
      await owned.reclaim();
    } finally {
      try {
        await host.close();
      } finally {
        await owners.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  signInAt(userRoot, "person-owner");
  await host.attachmentsSettled();
  const subject: FleetTestSubject = {
      nodeId: "node-one",
      repoId: "fleet-repo",
      taskId: "task-fleet",
      executionId: "execution-fleet",
      paths,
      viewId: "node-one",
    },
    slowSubject: FleetTestSubject = {
      ...subject,
      nodeId: "node-slow",
      viewId: "node-slow",
    },
    auth = owners.auth(subject);
  const created = await host.run(subject.repoId, { kind: "task-create", taskId: subject.taskId, title: "Fleet" }, auth);
  assert.equal(created.outcome, "applied");
  await waitForFleetPublication(host, subject.repoId, created.opId, auth);
  await realizeTaskPlanFixture(
    repo,
    String((created as Record<string, unknown>).packagePath),
    (planPath) => host.run(subject.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    "Fleet",
  );
  const started = await host.run(
    subject.repoId,
    { kind: "task-start", taskId: subject.taskId, executionId: subject.executionId },
    auth,
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  await waitForReceiptCommit(host, subject.repoId, started.opId, auth);
  return {
    root,
    repo,
    stateRoot,
    writerOptions: fleetHostWriterOptions(userRoot, ["fleet-repo"]),
    path: subject.paths[0]!,
    subject,
    slowSubject,
    auth,
    host,
    key,
    cert,
    certFile,
    emptyPath,
    track: owned.track,
    hold: owned.hold,
    setOwnerLookupDelay: (value: number) => {
      ownerLookupDelayMs = value;
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
    center: (port?: number, replicaWatchProgressMs?: number) =>
      owned.hold(
        listenFleetTls({
          ...(port === undefined ? {} : { port }),
          ...(replicaWatchProgressMs === undefined ? {} : { replicaWatchProgressMs }),
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
          authenticate: (nodeId, credential) =>
            [subject.nodeId, slowSubject.nodeId].includes(nodeId) && credential === "machine-secret",
          nodeOwner: async (nodeId) => {
            if (ownerLookupDelayMs) await new Promise((resolve) => setTimeout(resolve, ownerLookupDelayMs));
            return owners.nodeOwner(nodeId);
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
function localAuthFixture() {
  return {
    transportKind: "unix-socket" as const,
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary" as const,
    },
  };
}
async function crossRepoFixture(t: TestContext) {
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const host = await openDaemonHost({ daemonId: "fleet-cross-repo", userRoot }),
    owners = await fleetNodeOwners({
      userRoot,
      owners: { "node-shared": "person-owner" },
      repoIds: repos.map(({ repoId }) => repoId),
    }),
    subjects: FleetTestSubject[] = repos.map((repo) => ({
      nodeId: "node-shared",
      repoId: repo.repoId,
      taskId: "task-cross",
      executionId: "execution-cross",
      paths: [pathValue],
      viewId: "node-shared",
    }));
  t.after(async () => {
    try {
      await owned.reclaim();
    } finally {
      try {
        await host.close();
      } finally {
        await owners.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  signInAt(userRoot, "person-owner");
  await host.attachmentsSettled();
  for (const subject of subjects) {
    const auth = owners.auth(subject),
      taskRepo = repos.find((repo) => repo.repoId === subject.repoId)!;
    const created = await host.run(
      subject.repoId,
      { kind: "task-create", taskId: subject.taskId, title: "Cross" },
      auth,
    );
    assert.equal(created.outcome, "applied");
    await waitForFleetPublication(host, subject.repoId, created.opId, auth);
    await realizeTaskPlanFixture(
      taskRepo.rootDir,
      String((created as Record<string, unknown>).packagePath),
      (planPath) => host.run(subject.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      "Cross",
    );
    assert.equal(
      (
        await host.run(
          subject.repoId,
          { kind: "task-start", taskId: subject.taskId, executionId: subject.executionId },
          auth,
        )
      ).outcome,
      "applied",
    );
  }
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile);
  return {
    root,
    cert,
    subjects,
    path: pathValue,
    track: owned.track,
    hold: owned.hold,
    center: () =>
      owned.hold(
        listenFleetTls({
          host,
          stateRoot,
          ...fleetHostWriterOptions(
            userRoot,
            repos.map(({ repoId }) => repoId),
          ),
          key,
          cert,
          replicaDiskQuotaBytes: replicaQuota,
          authenticate: (nodeId, credential) => nodeId === "node-shared" && credential === "machine-secret",
          nodeOwner: owners.nodeOwner,
        }),
      ),
    close: async () => {
      await owned.reclaim();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function waitForReceiptCommit(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  repoId: string,
  opId: string,
  binding: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
): Promise<void> {
  const deadline = performance.now() + 15_000;
  do {
    const receipt = await host.run(repoId, { kind: "receipt-show", opId }, binding);
    if (typeof receipt.commitSha === "string") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  throw new Error(`Git materialization did not publish ${opId} within the bounded wait`);
}
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
async function ledgerBase(fixture: Awaited<ReturnType<typeof fleetFixture>>): Promise<{ ledger: LedgerCutIdentity }> {
  const status = await fixture.host.run(
    fixture.subject.repoId,
    { kind: "doc-status", paths: [fixture.path] },
    fixture.auth,
  );
  if (status.detail?.kind !== "doc_sync") throw new Error("doc status lacks ledger cut");
  return { ledger: status.detail.currentLedgerSha };
}
