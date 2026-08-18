// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { openDaemonHost, type DaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { randomUUID } from "node:crypto";

const replicaQuota = 64 * 1024 * 1024;

// Same fixture discipline as fleet-transport.integration: every OS resource is
// owned by the fixture and reclaimed through t.after, because a `node --test`
// timeout suspends the body and never runs try/finally teardown.
async function leaseFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-lease-")), repo = path.join(root, "repo"), userRoot = path.join(root, "user"), stateRoot = path.join(root, "state"), keyFile = path.join(root, "tls.key"), certFile = path.join(root, "tls.crt");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  const git = (...args: readonly string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Lease Test"); git("config", "user.email", "lease@example.invalid"); git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(path.join(repo, "harness/harness.yaml"), "schema: harness-anything/v1\nname: lease\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n");
  git("add", "harness"); git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: "lease-repo", userRoot, createConvenienceLinks: false });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost", "-days", "1", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const key = readFileSync(keyFile), cert = readFileSync(certFile);
  const assignment = (nodeId: string, personId: string): FleetAssignmentRecord => ({ nodeId, assignmentId: `assignment-${nodeId}`, repoId: "lease-repo", taskId: "task-seeded", executionId: "exe-seeded", paths: ["tasks/task-seeded-x/notes.md"], viewId: `${nodeId}-view`, expiresAt: "2099-01-01T00:00:00.000Z", actor: { principal: { personId }, executor: { kind: "agent", id: `agent-${nodeId}` } } });
  const assignments = [assignment("node-one", "person-one"), assignment("node-two", "person-two")], byId = new Map(assignments.map((value) => [value.assignmentId, value]));
  const hosts: DaemonHost[] = [], centers: FleetTlsCenter[] = [];
  const previousReap = process.env.HARNESS_LEASE_REAP_INTERVAL_MS;
  const openCenter = async (host: DaemonHost): Promise<FleetTlsCenter> => {
    process.env.HARNESS_LEASE_REAP_INTERVAL_MS = "250";
    try { const center = await listenFleetTls({ host, stateRoot, key, cert, replicaDiskQuotaBytes: replicaQuota, authenticate: (nodeId, credential) => credential === `secret-${nodeId}`, resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null }); centers.push(center); return center; }
    finally { if (previousReap === undefined) delete process.env.HARNESS_LEASE_REAP_INTERVAL_MS; else process.env.HARNESS_LEASE_REAP_INTERVAL_MS = previousReap; }
  };
  const openHost = (): Promise<DaemonHost> => openDaemonHost({ daemonId: "lease-center", userRoot }).then((host) => { hosts.push(host); return host; });
  const closeHost = async (host: DaemonHost): Promise<void> => { const at = hosts.indexOf(host); if (at >= 0) hosts.splice(at, 1); await host.close(); };
  const host = await openHost(), center = await openCenter(host);
  const command = (nodeId: string, action: Record<string, unknown>, waitMs = 5_000, taskId: string | null = typeof action.taskId === "string" ? action.taskId : null) => runFleetTaskCommandClient({ port: center.port, ca: cert, servername: "localhost", nodeId, credential: `secret-${nodeId}`, assignmentId: `assignment-${nodeId}`, opId: randomUUID(), repoId: "lease-repo", taskId, action: action as never, waitMs });
  const commandOn = (target: FleetTlsCenter, nodeId: string, action: Record<string, unknown>, waitMs = 5_000) => runFleetTaskCommandClient({ port: target.port, ca: cert, servername: "localhost", nodeId, credential: `secret-${nodeId}`, assignmentId: `assignment-${nodeId}`, opId: randomUUID(), repoId: "lease-repo", taskId: typeof action.taskId === "string" ? action.taskId : null, action: action as never, waitMs });
  const commitCount = (): number => Number(git("rev-list", "--count", "refs/ha/canonical"));
  return { root, repo, stateRoot, host, center, command, commandOn, openHost, openCenter, closeHost, commitCount, close: async () => { for (const target of centers.splice(0)) await target.close(); for (const target of hosts.splice(0)) await target.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("auto lease: create/start/progress over fleet TLS, second node queues and is woken by release", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture(); t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Lease loop" });
  assert.equal(created.outcome, "applied");
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.match(taskId, /^task_/u);
  const started = await fixture.command("node-one", { kind: "task-start", taskId });
  assert.equal(started.outcome, "applied");
  assert.equal(started.lease?.assignmentId, "assignment-node-one");
  assert.equal(fixture.center.status().leases.leases[0]?.assignmentId, "assignment-node-one");
  const progressed = await fixture.command("node-one", { kind: "task-progress-append", taskId, text: "holder writes through the automatic lease" });
  assert.equal(progressed.outcome, "applied");
  // A second collaborator's start parks in the FIFO queue instead of failing.
  let secondStarted = false;
  const waiting = fixture.command("node-two", { kind: "task-start", taskId }).then((result) => { secondStarted = true; return result; });
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
  const takenOver = await fixture.command("node-two", { kind: "task-progress-append", taskId, text: "the woken head now holds the lease" });
  assert.equal(takenOver.outcome, "applied");
});

test("orphan reaper releases an expired fleet lease so another node can claim the task", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture(); t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Orphan reap" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  const started = await fixture.command("node-one", { kind: "task-start", taskId, ttlMs: 600 });
  assert.equal(started.outcome, "applied");
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  assert.equal(fixture.center.status().leases.leases.length, 0, "the reaper must clear the expired grant");
  // task-start can only apply when the domain lease is gone, so this claim is
  // itself the proof that the reaper released the canonical lease record.
  const claimed = await fixture.command("node-two", { kind: "task-start", taskId });
  assert.equal(claimed.outcome, "applied");
  assert.equal(claimed.lease?.assignmentId, "assignment-node-two");
});

test("a parked command settles as wait_expired at its deadline and frees the queue", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture(); t.after(() => fixture.close());
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
  const fixture = await leaseFixture(); t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Restart survival" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
  await fixture.center.close();
  await fixture.closeHost(fixture.host);
  // A full warm restart: the daemon host re-attaches from the Git ledger and
  // the broker reloads its persisted coordination state from the same root.
  const host = await fixture.openHost(), reopened = await fixture.openCenter(host);
  assert.equal(reopened.status().leases.leases[0]?.assignmentId, "assignment-node-one", "the lease table must survive the restart");
  const progressed = await fixture.commandOn(reopened, "node-one", { kind: "task-progress-append", taskId, text: "the original holder still writes after the restart" });
  assert.equal(progressed.outcome, "applied");
  let secondDone = false;
  const waiting = fixture.commandOn(reopened, "node-two", { kind: "task-start", taskId }).then((result) => { secondDone = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(secondDone, false, "the survived grant must still queue the second node");
  assert.equal((await fixture.commandOn(reopened, "node-one", { kind: "task-release", taskId })).outcome, "applied");
  const granted = await waiting;
  assert.equal(granted.outcome, "applied");
  assert.equal(granted.lease?.assignmentId, "assignment-node-two");
});

test("opId replay returns the stored receipt; a different action under the same opId conflicts", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture(); t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Replay" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  await fixture.command("node-one", { kind: "task-start", taskId });
  const send = (opId: string, text: string) => runFleetTaskCommandClient({ port: fixture.center.port, ca: readFileSync(path.join(fixture.root, "tls.crt")), servername: "localhost", nodeId: "node-one", credential: "secret-node-one", assignmentId: "assignment-node-one", opId, repoId: "lease-repo", taskId, action: { kind: "task-progress-append", taskId, text }, waitMs: 5_000 });
  const opId = randomUUID(), first = await send(opId, "first entry"), replay = await send(opId, "first entry"), conflict = await send(opId, "different entry");
  assert.equal(first.outcome, "applied");
  assert.equal(replay.outcome, "applied");
  assert.equal(replay.revision, first.revision, "replay must not append a second event");
  assert.equal(conflict.outcome, "op_rejected");
  assert.equal(conflict.code, "op_conflict");
});

test("frame hygiene: cross-repo and missing taskId are rejected before any write", { timeout: 30_000 }, async (t) => {
  const fixture = await leaseFixture(); t.after(() => fixture.close());
  const created = await fixture.command("node-one", { kind: "task-create", title: "Hygiene" });
  const taskId = String((created.receipt as Record<string, unknown>).taskId);
  const before = fixture.commitCount();
  const wrongRepo = await runFleetTaskCommandClient({ port: fixture.center.port, ca: readFileSync(path.join(fixture.root, "tls.crt")), servername: "localhost", nodeId: "node-one", credential: "secret-node-one", assignmentId: "assignment-node-one", opId: randomUUID(), repoId: "lease-other", taskId, action: { kind: "task-start", taskId }, waitMs: 1_000 });
  assert.equal(wrongRepo.outcome, "op_rejected");
  assert.equal(wrongRepo.code, "assignment_rejected");
  const noTask = await runFleetTaskCommandClient({ port: fixture.center.port, ca: readFileSync(path.join(fixture.root, "tls.crt")), servername: "localhost", nodeId: "node-one", credential: "secret-node-one", assignmentId: "assignment-node-one", opId: randomUUID(), repoId: "lease-repo", taskId: null, action: { kind: "task-start" }, waitMs: 1_000 });
  assert.equal(noTask.outcome, "op_rejected");
  assert.equal(noTask.code, "task_command_rejected");
  assert.equal(fixture.commitCount(), before);
});
