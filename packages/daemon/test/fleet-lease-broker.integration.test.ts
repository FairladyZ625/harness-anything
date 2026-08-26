// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, registerDaemonRepo } from "../../kernel/src/index.ts";
import { openDaemonHost, type DaemonHost } from "../src/daemon-host.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetTaskCommandClient, runFleetUploadClient } from "../src/fleet/edge.ts";
import { fleetLeaseTimers } from "../src/lease-broker.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { randomUUID } from "node:crypto";

const replicaQuota = 64 * 1024 * 1024;

// Same fixture discipline as fleet-transport.integration: every OS resource is
// owned by the fixture and reclaimed through t.after, because a `node --test`
// timeout suspends the body and never runs try/finally teardown.
async function leaseFixture(wrapRun?: (run: DaemonHost["run"]) => DaemonHost["run"]) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-lease-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Lease Test");
  git("config", "user.email", "lease@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: lease\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git("add", "harness");
  git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "lease-repo", userRoot, createConvenienceLinks: false });
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
    cert = readFileSync(certFile);
  const assignment = (nodeId: string, personId: string): FleetAssignmentRecord => ({
    nodeId,
    assignmentId: `assignment-${nodeId}`,
    repoId: "lease-repo",
    taskId: "task-seeded",
    executionId: "exe-seeded",
    paths: ["tasks/task-seeded-x/notes.md"],
    viewId: `${nodeId}-view`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    actor: { principal: { personId }, executor: { kind: "agent", id: `agent-${nodeId}` } },
  });
  const assignments = [assignment("node-one", "person-one"), assignment("node-two", "person-two")],
    byId = new Map(assignments.map((value) => [value.assignmentId, value]));
  const hosts: DaemonHost[] = [],
    centers: FleetTlsCenter[] = [];
  const previousReap = process.env.HARNESS_LEASE_REAP_INTERVAL_MS;
  const openCenter = async (host: DaemonHost, port?: number): Promise<FleetTlsCenter> => {
    process.env.HARNESS_LEASE_REAP_INTERVAL_MS = "250";
    try {
      const center = await listenFleetTls({
        host,
        stateRoot,
        key,
        cert,
        ...(port === undefined ? {} : { port }),
        replicaDiskQuotaBytes: replicaQuota,
        authenticate: (nodeId, credential) => credential === `secret-${nodeId}`,
        resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null,
      });
      centers.push(center);
      return center;
    } finally {
      if (previousReap === undefined) delete process.env.HARNESS_LEASE_REAP_INTERVAL_MS;
      else process.env.HARNESS_LEASE_REAP_INTERVAL_MS = previousReap;
    }
  };
  const openHost = async (): Promise<DaemonHost> => {
    const host = await openDaemonHost({ daemonId: "lease-center", userRoot });
    await host.attachmentsSettled();
    const wrapped = wrapRun ? { ...host, run: wrapRun(host.run) } : host;
    hosts.push(wrapped);
    return wrapped;
  };
  const closeHost = async (host: DaemonHost): Promise<void> => {
    const at = hosts.indexOf(host);
    if (at >= 0) hosts.splice(at, 1);
    await host.close();
  };
  const host = await openHost(),
    center = await openCenter(host);
  const command = (
    nodeId: string,
    action: Record<string, unknown>,
    waitMs = 5_000,
    taskId: string | null = typeof action.taskId === "string" ? action.taskId : null,
  ) =>
    runFleetTaskCommandClient({
      port: center.port,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      assignmentId: `assignment-${nodeId}`,
      opId: randomUUID(),
      repoId: "lease-repo",
      taskId,
      action: action as never,
      waitMs,
    });
  const commandOn = (target: FleetTlsCenter, nodeId: string, action: Record<string, unknown>, waitMs = 5_000) =>
    runFleetTaskCommandClient({
      port: target.port,
      ca: cert,
      servername: "localhost",
      nodeId,
      credential: `secret-${nodeId}`,
      assignmentId: `assignment-${nodeId}`,
      opId: randomUUID(),
      repoId: "lease-repo",
      taskId: typeof action.taskId === "string" ? action.taskId : null,
      action: action as never,
      waitMs,
    });
  const commitCount = (): number => Number(git("rev-list", "--count", "refs/ha/canonical"));
  return {
    root,
    repo,
    stateRoot,
    host,
    center,
    command,
    commandOn,
    openHost,
    openCenter,
    closeHost,
    commitCount,
    assignmentFor: (nodeId: string): FleetAssignmentRecord => byId.get(`assignment-${nodeId}`)!,
    close: async () => {
      for (const target of centers.splice(0)) await target.close();
      for (const target of hosts.splice(0)) await target.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "auto lease: create/start/progress over fleet TLS, second node queues and is woken by release",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Lease loop" });
    assert.equal(created.outcome, "applied");
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    assert.match(taskId, /^task_/u);
    const started = await fixture.command("node-one", { kind: "task-start", taskId });
    assert.equal(started.outcome, "applied");
    assert.equal(started.lease?.assignmentId, "assignment-node-one");
    assert.equal(fixture.center.status().leases.leases[0]?.assignmentId, "assignment-node-one");
    const progressed = await fixture.command("node-one", {
      kind: "task-progress-append",
      taskId,
      text: "holder writes through the automatic lease",
    });
    assert.equal(progressed.outcome, "applied");
    // A second collaborator's start parks in the FIFO queue instead of failing.
    let secondStarted = false;
    const waiting = fixture.command("node-two", { kind: "task-start", taskId }).then((result) => {
      secondStarted = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(secondStarted, false, "the second start must still be parked");
    assert.equal(fixture.center.status().leases.queue.length, 1);
    // The holder releases; the queue head is woken and executes server-side.
    const released = await fixture.command("node-one", { kind: "task-release", taskId, reason: "holder done for now" });
    assert.equal(released.outcome, "applied");
    const granted = await waiting;
    assert.equal(granted.outcome, "applied");
    assert.equal(granted.lease?.assignmentId, "assignment-node-two");
    assert.equal(fixture.center.status().leases.leases[0]?.assignmentId, "assignment-node-two");
    const takenOver = await fixture.command("node-two", {
      kind: "task-progress-append",
      taskId,
      text: "the woken head now holds the lease",
    });
    assert.equal(takenOver.outcome, "applied");
  },
);

test(
  "fleet fallback settlement atomically releases its assignment Task and moves it to blocked",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Fallback exhausted" }),
      taskId = String((created.receipt as Record<string, unknown>).taskId);
    const started = await fixture.command("node-one", { kind: "task-start", taskId });
    assert.equal(started.outcome, "applied");
    const executionId = String(started.lease?.executionId);
    assert.equal(
      (
        await fixture.command("node-one", {
          kind: "task-fallback-exhausted",
          taskId,
          executionId,
          reason: "provider chain exhausted",
        })
      ).outcome,
      "applied",
    );
    const projection = makeTaskProjection({
      rootDir: fixture.repo,
      eventStore: makeTaskEventStore({ repoId: "lease-repo", rootDir: fixture.repo }),
    });
    try {
      const snapshot = projection.read(taskId).snapshot;
      assert.equal(snapshot.task?.status, "blocked");
      assert.equal(snapshot.lease, null);
    } finally {
      projection.close();
    }
  },
);

test(
  "orphan reaper releases an expired fleet lease so another node can claim the task",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Orphan reap" });
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    const started = await fixture.command("node-one", { kind: "task-start", taskId, ttlMs: 2_000 });
    assert.equal(started.outcome, "applied");
    await waitUntil(
      () => fixture.center.status().leases.leases.length === 0,
      "the reaper must clear the expired grant",
    );
    assert.equal(fixture.center.status().leases.leases.length, 0, "the reaper must clear the expired grant");
    // task-start can only apply when the domain lease is gone, so this claim is
    // itself the proof that the reaper released the canonical lease record.
    const claimed = await fixture.command("node-two", { kind: "task-start", taskId });
    assert.equal(claimed.outcome, "applied");
    assert.equal(claimed.lease?.assignmentId, "assignment-node-two");
  },
);

test("a parked command settles as wait_expired at its deadline and frees the queue", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture();
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Wait expiry" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
  const expired = await fixture.command("node-two", { kind: "task-start", taskId }, 500);
  assert.equal(expired.outcome, "wait_expired");
  assert.equal(expired.code, "wait_expired");
  assert.equal(fixture.center.status().leases.queue.length, 0);
  // The task itself is untouched: no auto-complete, no rollback.
  assert.equal(fixture.center.status().leases.leases[0]?.assignmentId, "assignment-node-one");
});

test("center restart preserves the grant mirror, the domain lease, and FIFO order", { timeout: 60_000 }, async (t) => {
  const fixture = await leaseFixture();
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Restart survival" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
  await fixture.center.close();
  await fixture.closeHost(fixture.host);
  // A full warm restart: the daemon host re-attaches from the Git ledger and
  // the broker reloads its persisted coordination state from the same root.
  const host = await fixture.openHost(),
    reopened = await fixture.openCenter(host);
  assert.equal(
    reopened.status().leases.leases[0]?.assignmentId,
    "assignment-node-one",
    "the lease table must survive the restart",
  );
  const progressed = await fixture.commandOn(reopened, "node-one", {
    kind: "task-progress-append",
    taskId,
    text: "the original holder still writes after the restart",
  });
  assert.equal(progressed.outcome, "applied");
  let secondDone = false;
  const waiting = fixture.commandOn(reopened, "node-two", { kind: "task-start", taskId }).then((result) => {
    secondDone = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(secondDone, false, "the survived grant must still queue the second node");
  assert.equal((await fixture.commandOn(reopened, "node-one", { kind: "task-release", taskId })).outcome, "applied");
  const granted = await waiting;
  assert.equal(granted.outcome, "applied");
  assert.equal(granted.lease?.assignmentId, "assignment-node-two");
});

test(
  "a stale center writer epoch is rejected at append and produces no canonical write",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Epoch fence" });
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
    const oldEpoch = (
      JSON.parse(readFileSync(path.join(fixture.stateRoot, "writer-epochs.json"), "utf8")) as {
        repos: Record<string, { epoch: number }>;
      }
    ).repos["lease-repo"]!.epoch;
    const replacement = await fixture.openCenter(fixture.host);
    const before = fixture.commitCount();
    // The stale endpoint must not adopt the replacement's epoch merely because
    // assignment admission can read the shared state row. Its own append guard
    // remains bound to the epoch it acquired at startup.
    const staleAuto = await fixture.command("node-one", {
      kind: "task-progress-append",
      taskId,
      text: "stale endpoint must not adopt successor epoch",
    });
    assert.equal(staleAuto.outcome, "op_rejected");
    assert.equal(staleAuto.code, "writer_epoch_stale");
    assert.equal((staleAuto.receipt as Record<string, unknown>)?.code, "operation_not_published");
    assert.equal(fixture.commitCount(), before, "automatic assignment admission must not let a stale endpoint append");
    const stale = await runFleetTaskCommandClient({
      port: fixture.center.port,
      ca: readFileSync(path.join(fixture.root, "tls.crt")),
      servername: "localhost",
      nodeId: "node-one",
      credential: "secret-node-one",
      assignmentId: "assignment-node-one",
      writerEpoch: oldEpoch,
      opId: randomUUID(),
      repoId: "lease-repo",
      taskId,
      action: { kind: "task-progress-append", taskId, text: "stale writer must not append" },
      waitMs: 5_000,
    });
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "writer_epoch_stale");
    assert.equal(fixture.commitCount(), before, "the stale center must produce zero canonical commits");
    const fresh = await fixture.commandOn(replacement, "node-one", {
      kind: "task-progress-append",
      taskId,
      text: "fresh epoch append",
    });
    assert.equal(fresh.outcome, "applied");
  },
);

test("stale task rejection disposes carried document claims", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture();
  t.after(() => fixture.close());
  const peer = {
      port: fixture.center.port,
      ca: readFileSync(path.join(fixture.root, "tls.crt")),
      servername: "localhost",
      nodeId: "node-one",
      credential: "secret-node-one",
      assignmentId: "assignment-node-one",
    },
    pathValue = fixture.assignmentFor("node-one").paths[0]!;
  const descriptors = await runFleetUploadClient({
    ...peer,
    changes: [{ path: pathValue, body: "stale candidate\n" }],
  });
  const oldEpoch = (
    JSON.parse(readFileSync(path.join(fixture.stateRoot, "writer-epochs.json"), "utf8")) as {
      repos: Record<string, { epoch: number }>;
    }
  ).repos["lease-repo"]!.epoch;
  const authority = openPersistentWriterEpoch({ stateRoot: fixture.stateRoot, holderId: "claim-successor" });
  authority.acquire("lease-repo");
  const result = await runFleetTaskCommandClient({
    ...peer,
    writerEpoch: oldEpoch,
    opId: randomUUID(),
    repoId: "lease-repo",
    taskId: "task-seeded",
    action: { kind: "task-progress-append", taskId: "task-seeded", text: "never execute" } as never,
    waitMs: 1_000,
    docChanges: descriptors.map((candidate) => ({
      path: pathValue,
      baseBlobSha256: null,
      policyId: "markdown-body-replaceable/v1",
      candidate,
    })),
  });
  const state = JSON.parse(readFileSync(path.join(fixture.stateRoot, "state.json"), "utf8")) as {
    uploads: Record<string, unknown>;
  };
  assert.equal(result.code, "writer_epoch_stale");
  assert.equal(Object.keys(state.uploads).length, 0);
  authority.close();
});

test(
  "opId replay returns the stored receipt; a different action under the same opId conflicts",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Replay" });
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    await fixture.command("node-one", { kind: "task-start", taskId });
    const send = (opId: string, text: string) =>
      runFleetTaskCommandClient({
        port: fixture.center.port,
        ca: readFileSync(path.join(fixture.root, "tls.crt")),
        servername: "localhost",
        nodeId: "node-one",
        credential: "secret-node-one",
        assignmentId: "assignment-node-one",
        opId,
        repoId: "lease-repo",
        taskId,
        action: { kind: "task-progress-append", taskId, text },
        waitMs: 5_000,
      });
    const opId = randomUUID(),
      first = await send(opId, "first entry"),
      replay = await send(opId, "first entry"),
      conflict = await send(opId, "different entry");
    assert.equal(first.outcome, "applied");
    assert.equal(replay.outcome, "applied");
    assert.equal(replay.revision, first.revision, "replay must not append a second event");
    assert.equal(conflict.outcome, "op_rejected");
    assert.equal(conflict.code, "op_conflict");
  },
);

test("frame hygiene: cross-repo and missing taskId are rejected before any write", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture();
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Hygiene" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  const before = fixture.commitCount();
  const wrongRepo = await runFleetTaskCommandClient({
    port: fixture.center.port,
    ca: readFileSync(path.join(fixture.root, "tls.crt")),
    servername: "localhost",
    nodeId: "node-one",
    credential: "secret-node-one",
    assignmentId: "assignment-node-one",
    opId: randomUUID(),
    repoId: "lease-other",
    taskId,
    action: { kind: "task-start", taskId },
    waitMs: 1_000,
  });
  assert.equal(wrongRepo.outcome, "op_rejected");
  assert.equal(wrongRepo.code, "assignment_rejected");
  const noTask = await runFleetTaskCommandClient({
    port: fixture.center.port,
    ca: readFileSync(path.join(fixture.root, "tls.crt")),
    servername: "localhost",
    nodeId: "node-one",
    credential: "secret-node-one",
    assignmentId: "assignment-node-one",
    opId: randomUUID(),
    repoId: "lease-repo",
    taskId: null,
    action: { kind: "task-start" },
    waitMs: 1_000,
  });
  assert.equal(noTask.outcome, "op_rejected");
  assert.equal(noTask.code, "task_command_rejected");
  assert.equal(fixture.commitCount(), before);
});

test(
  "crash window restart: a domain lease whose mirror row was lost is rebuilt, not dropped",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Crash window" });
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    // Simulate the crash window: the domain task-start commits through the host
    // directly while the broker never records its grant (center died between
    // the domain write and the mirror bookkeeping, then restarted).
    const direct = await fixture.host.run(
      "lease-repo",
      { kind: "task-start", taskId },
      { transportKind: "fleet-tls", assignmentBinding: fixture.assignmentFor("node-one") },
    );
    assert.equal(direct.outcome, "applied");
    assert.equal(fixture.center.status().leases.leases.length, 0, "precondition: the broker mirror is empty");
    await fixture.center.close();
    await fixture.closeHost(fixture.host);
    const host = await fixture.openHost(),
      reopened = await fixture.openCenter(host);
    assert.equal(reopened.status().leases.leases.length, 0, "the restarted broker begins from the lost-mirror state");
    // The other node's start must RECONCILE from the domain lease (rebuild the
    // row via roster attribution) and queue behind it — not delete the mirror
    // and strand the domain orphan.
    let secondResolved = false;
    const waiting = fixture.commandOn(reopened, "node-two", { kind: "task-start", taskId }).then((result) => {
      secondResolved = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(secondResolved, false, "the second start parks behind the reconciled lease");
    const reconciled = reopened.status().leases.leases;
    assert.equal(reconciled.length, 1);
    assert.equal(
      reconciled[0]?.assignmentId,
      "assignment-node-one",
      "the mirror row is rebuilt from the domain lease attribution",
    );
    assert.equal((await fixture.commandOn(reopened, "node-one", { kind: "task-release", taskId })).outcome, "applied");
    const granted = await waiting;
    assert.equal(granted.outcome, "applied");
    assert.equal(granted.lease?.assignmentId, "assignment-node-two");
  },
);

test("a failed orphan release keeps the mirror row and the reaper retries it", { timeout: 30_000 }, async (t) => {
  let releaseFails = true,
    releaseAttempts = 0;
  const fixture = await leaseFixture((run) => (repoId, action, auth) => {
    if (action.kind === "task-release") releaseAttempts += 1;
    return action.kind === "task-release" && releaseFails
      ? Promise.reject(new Error("simulated release infrastructure failure"))
      : run(repoId, action, auth);
  });
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Reaper retry" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId, ttlMs: 2_000 })).outcome, "applied");
  await waitUntil(() => releaseAttempts > 0, "the reaper must attempt the simulated failed release");
  const retained = fixture.center.status().leases.leases;
  assert.equal(retained.length, 1, "a failed release must keep the mirror row for the next sweep");
  assert.equal(retained[0]?.assignmentId, "assignment-node-one");
  releaseFails = false;
  for (let index = 0; index < 20 && fixture.center.status().leases.leases.length > 0; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fixture.center.status().leases.leases.length, 0, "the retried release clears the row");
  const claimed = await fixture.command("node-two", { kind: "task-start", taskId });
  assert.equal(claimed.outcome, "applied");
  assert.equal(claimed.lease?.assignmentId, "assignment-node-two");
});

test("a rejected domain probe cannot erase the mirror or wake a waiter", { timeout: 30_000 }, async (t) => {
  let rejectProbe = false,
    rejectedProbes = 0;
  const fixture = await leaseFixture((run) => async (repoId, action, auth) => {
    if (action.kind === "task-show" && rejectProbe) {
      rejectedProbes += 1;
      return {
        outcome: "op_rejected",
        opId: "probe-unavailable",
        code: "repo_unavailable",
        nextAction: "retry the canonical read",
      };
    }
    return run(repoId, action, auth);
  });
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Probe fail closed" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId, ttlMs: 2_000 })).outcome, "applied");
  rejectProbe = true;
  await waitUntil(() => rejectedProbes > 0, "the reaper must observe the rejected domain probe");
  assert.equal(
    fixture.center.status().leases.leases[0]?.assignmentId,
    "assignment-node-one",
    "an unavailable canonical read preserves the coordination mirror",
  );
  rejectProbe = false;
  for (let index = 0; index < 20 && fixture.center.status().leases.leases.length > 0; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fixture.center.status().leases.leases.length, 0, "a later successful probe lets the reaper complete");
  assert.equal((await fixture.command("node-two", { kind: "task-start", taskId })).outcome, "applied");
});

test(
  "two simultaneous first-starts serialize: exactly one grants, the other queues",
  { timeout: 30_000 },
  async (t) => {
    // The asymmetric probe delay forces the adversarial interleaving: the slow
    // prober reads an empty domain (its task-show completes early) but decides
    // 300ms later, so a non-atomic check-and-reserve acting on the stale read
    // would overwrite the winner's mirror row and drop it when the domain
    // rejects the second grab.
    const fixture = await leaseFixture(
      (run) => (repoId, action, auth) =>
        run(repoId, action, auth).then((receipt) =>
          action.kind === "task-show" && auth.assignmentBinding?.nodeId === "node-one"
            ? new Promise((resolve) => setTimeout(resolve, 300)).then(() => receipt)
            : receipt,
        ),
    );
    t.after(() => fixture.close());
    const created = await fixture.command("node-one", { kind: "task-create", title: "Concurrent first grab" });
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    const outcomes: string[] = [];
    const slow = fixture.command("node-one", { kind: "task-start", taskId }).then((result) => {
      outcomes.push(`one:${result.outcome}:${result.code ?? null}`);
      return result;
    });
    const fast = fixture.command("node-two", { kind: "task-start", taskId }).then((result) => {
      outcomes.push(`two:${result.outcome}:${result.code ?? null}`);
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      outcomes.length,
      1,
      `exactly one start applies immediately; the loser must park, not race (saw: ${outcomes.join(", ")})`,
    );
    assert.match(
      outcomes[0]!,
      /:applied:undefined$|:applied:null$/u,
      "the immediate winner applies without a lease_conflict",
    );
    assert.equal(fixture.center.status().leases.queue.length, 1);
    const winner = outcomes[0]!.startsWith("two:") ? "node-two" : "node-one",
      loser = winner === "node-two" ? "node-one" : "node-two";
    assert.equal(fixture.center.status().leases.leases[0]?.assignmentId, `assignment-${winner}`);
    await (winner === "node-two" ? fast : slow);
    assert.equal((await fixture.command(winner, { kind: "task-release", taskId })).outcome, "applied");
    const granted = await (loser === "node-two" ? fast : slow);
    assert.equal(granted.outcome, "applied");
    assert.equal(granted.lease?.assignmentId, `assignment-${loser}`);
  },
);

test("a failed queue head drains and latecomers cannot jump the FIFO", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture();
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Failed head FIFO" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
  const marks: string[] = [];
  const progressHead = fixture
    .command("node-two", { kind: "task-progress-append", taskId, text: "queued behind the holder" })
    .then((result) => {
      marks.push(`progress:${result.outcome}:${result.code}`);
      return result;
    });
  const queuedStart = fixture.command("node-two", { kind: "task-start", taskId }).then((result) => {
    marks.push(`start:${result.outcome}`);
    return result;
  });
  // A late non-holder arrival must enqueue behind the existing waiters. (The
  // holder's own start would execute directly and earn its honest domain
  // rejection — that is the no-self-queue rule, not a jump. The latecomer
  // uses the auto execution id so it rejoins the round the way the domain
  // requires after a release.)
  const latecomer = fixture.command("node-two", { kind: "task-start", taskId }).then((result) => {
    marks.push(`late:${result.outcome}`);
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(marks.length, 0, "nobody jumps the queue while the holder holds");
  assert.equal(fixture.center.status().leases.queue.length, 3);
  assert.equal((await fixture.command("node-one", { kind: "task-release", taskId })).outcome, "applied");
  // The non-acquire head fails fast (no lease for node-two yet) and drains;
  // the queued start takes the lease; the latecomer waits behind it.
  const drained = await Promise.race([
    progressHead,
    new Promise<string>((resolve) => setTimeout(() => resolve("progress-still-pending"), 3_000)),
  ]);
  assert.notEqual(drained, "progress-still-pending", "the failed head must leave the queue");
  const started = await queuedStart;
  assert.equal(started.outcome, "applied");
  assert.equal(started.lease?.assignmentId, "assignment-node-two");
  let lateDone = false;
  latecomer.then(() => {
    lateDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(lateDone, false, "the latecomer stays queued behind the new holder");
  assert.equal((await fixture.command("node-two", { kind: "task-release", taskId })).outcome, "applied");
  const late = await latecomer;
  assert.equal(late.outcome, "applied");
});

test(
  "mid-wait disconnect automatically reconnects with the same opId and queue slot",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await leaseFixture();
    t.after(async () => {
      closeProxy();
      await fixture.close();
    });
    const created = await fixture.command("node-one", { kind: "task-create", title: "Disconnect reattach" });
    const taskId = String((created.receipt as Record<string, unknown>).taskId);
    assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
    let proxyConnections = 0;
    const proxySockets = new Set<import("node:net").Socket>(),
      proxy = import("node:net").then(
        ({ createServer }) =>
          new Promise<{ readonly port: number }>((resolve) => {
            const server = createServer((client) => {
              proxyConnections += 1;
              proxySockets.add(client);
              const upstream = import("node:net").then(({ connect }) => connect(fixture.center.port, "127.0.0.1"));
              upstream.then((target) => {
                client.pipe(target);
                target.pipe(client);
                client.on("close", () => target.destroy());
                target.on("close", () => client.destroy());
              });
            });
            server.listen(0, "127.0.0.1", () =>
              resolve({ port: (server.address() as import("node:net").AddressInfo).port }),
            );
            t.after(() => server.close());
          }),
      );
    function closeProxy(): void {
      for (const socket of proxySockets) socket.destroy();
    }
    const { port: proxyPort } = await proxy,
      caPath = path.join(fixture.root, "tls.crt");
    const viaProxy = runFleetEdgeTask({
      payload: {
        host: "127.0.0.1",
        port: proxyPort,
        caPath,
        servername: "localhost",
        nodeId: "node-two",
        credential: "secret-node-two",
        assignmentId: "assignment-node-two",
        repoId: "lease-repo",
        viewRoot: path.join(fixture.root, "edge-two-view"),
        quotaBytes: replicaQuota,
        waitTimeoutMs: 8_000,
        action: { kind: "task-start", taskId },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(fixture.center.status().leases.queue.length, 1, "the command parked through the proxy");
    const queuedOpId = fixture.center.status().leases.queue[0]!.opId;
    closeProxy();
    for (let attempt = 0; attempt < 30 && proxyConnections < 2; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      proxyConnections >= 2,
      "the product edge path reconnects promptly instead of waiting for the business deadline",
    );
    assert.equal(fixture.center.status().leases.queue.length, 1, "re-attach did not duplicate the queue item");
    assert.equal(
      fixture.center.status().leases.queue[0]?.opId,
      queuedOpId,
      "the re-attach kept the original opId and FIFO slot",
    );
    assert.equal((await fixture.command("node-one", { kind: "task-release", taskId })).outcome, "applied");
    const granted = await viaProxy;
    assert.equal(granted.outcome, "applied");
    const fleet = granted.fleet as {
      readonly commandOpId?: string;
      readonly lease?: { readonly assignmentId?: string };
    };
    assert.equal(fleet.commandOpId, queuedOpId);
    assert.equal(fleet.lease?.assignmentId, "assignment-node-two");
  },
);

test("a queued product command re-attaches after a center restart on the same port", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture();
  t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Queued restart" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
  const port = fixture.center.port,
    queued = runFleetEdgeTask({
      payload: {
        host: "127.0.0.1",
        port,
        caPath: path.join(fixture.root, "tls.crt"),
        servername: "localhost",
        nodeId: "node-two",
        credential: "secret-node-two",
        assignmentId: "assignment-node-two",
        repoId: "lease-repo",
        viewRoot: path.join(fixture.root, "restart-edge-view"),
        quotaBytes: replicaQuota,
        waitTimeoutMs: 10_000,
        action: { kind: "task-start", taskId },
      },
    });
  for (let attempt = 0; attempt < 30 && fixture.center.status().leases.queue.length !== 1; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const queuedOpId = fixture.center.status().leases.queue[0]?.opId;
  assert.ok(queuedOpId);
  await fixture.center.close();
  const reopened = await fixture.openCenter(fixture.host, port);
  assert.equal(
    reopened.status().leases.queue[0]?.opId,
    queuedOpId,
    "the persisted FIFO slot survives the center restart",
  );
  assert.equal((await fixture.commandOn(reopened, "node-one", { kind: "task-release", taskId })).outcome, "applied");
  const granted = await queued,
    fleet = granted.fleet as { readonly commandOpId?: string; readonly lease?: { readonly assignmentId?: string } };
  assert.equal(granted.outcome, "applied");
  assert.equal(fleet.commandOpId, queuedOpId, "the edge re-used the original opId after center_closing");
  assert.equal(fleet.lease?.assignmentId, "assignment-node-two");
});

test("an in-flight opId is deduplicated and the wait default is thirty minutes", { timeout: 30_000 }, async (t) => {
  assert.equal(fleetLeaseTimers({}).maxWaitMs, 30 * 60 * 1_000);
  const fixture = await leaseFixture((run) => async (repoId, action, auth) => {
    if (action.kind === "task-create") await new Promise((resolve) => setTimeout(resolve, 400));
    return run(repoId, action, auth);
  });
  t.after(() => fixture.close());
  const opId = randomUUID(),
    send = () =>
      runFleetTaskCommandClient({
        port: fixture.center.port,
        ca: readFileSync(path.join(fixture.root, "tls.crt")),
        servername: "localhost",
        nodeId: "node-one",
        credential: "secret-node-one",
        assignmentId: "assignment-node-one",
        opId,
        repoId: "lease-repo",
        taskId: null,
        action: { kind: "task-create", title: "In-flight dedup" },
        waitMs: 5_000,
      });
  const [first, second] = await Promise.all([send(), send()]);
  const codes = [first, second].map((result) => `${result.outcome}:${result.code}`).sort();
  assert.deepEqual(codes, ["applied:null", "op_rejected:op_in_flight"]);
});

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(message);
}
