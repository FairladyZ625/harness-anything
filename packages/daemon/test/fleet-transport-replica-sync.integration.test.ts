// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fleetHostWriterOptions, fleetLedgerRevision, waitForFleetPublication } from "./fleet-store.fixture.ts";
import { setTimeout as delay } from "node:timers/promises";
import { sha256Bytes, type LedgerCutIdentity } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import {
  readFleetAssignmentClient,
  runFleetReplicaPullClient,
  runFleetWriteClient,
  type FleetReplicaPullClientOptions,
  type FleetWriteClientOptions,
} from "../src/fleet/edge.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { type FleetCut } from "../src/fleet/contract.ts";
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
test("cross-repo transfer identity keeps equal node/view/cut/digest isolated", { timeout: 30_000 }, async (t) => {
  const fixture = await crossRepoFixture(t);
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
test("multi-path assignment produces a complete first snapshot and a scoped delta", { timeout: 30_000 }, async (t) => {
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
  const fixture = await fleetFixture(t),
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
    writePeopleFixture(repo.rootDir);
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
  for (const assignment of assignments) {
    const auth = { transportKind: "fleet-tls" as const, assignmentBinding: assignment },
      taskRepo = repos.find((repo) => repo.repoId === assignment.repoId)!;
    const created = await host.run(
      assignment.repoId,
      { kind: "task-create", taskId: assignment.taskId, title: "Cross" },
      auth,
    );
    assert.equal(created.outcome, "applied");
    await waitForFleetPublication(host, assignment.repoId, created.opId, auth);
    await realizeTaskPlanFixture(
      taskRepo.rootDir,
      String((created as Record<string, unknown>).packagePath),
      (planPath) => host.run(assignment.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      "Cross",
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
async function ledgerBase(fixture: Awaited<ReturnType<typeof fleetFixture>>): Promise<{ ledger: LedgerCutIdentity }> {
  const status = await fixture.host.run(
    fixture.assignment.repoId,
    { kind: "doc-status", paths: [fixture.path] },
    fixture.auth,
  );
  if (status.detail?.kind !== "doc_sync") throw new Error("doc status lacks ledger cut");
  return { ledger: status.detail.currentLedgerSha };
}
