// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { readFileSync } from "node:fs";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { fleetFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { startResidentReplicaSync } from "./replica-catch-up.fixture.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";

test("failed-spawn release is fenced against a replacement lease on either node", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetNodeClaimFixture(t),
    taskId = "task-release-fence";
  assert.equal(
    (await fixture.command("node-one", { kind: "task-create", taskId, title: "Lease fence" })).outcome,
    "applied",
  );
  const started = await fixture.command("node-one", { kind: "task-start", taskId });
  assert.equal(started.outcome, "applied");
  const context = () =>
    fixture.host.read("lease-repo", "repo.tasks.runtimeContext.read", { taskId }, localAuthFixture());
  assert.equal((await context()).snapshot.lease?.phase, "held");
  const release = {
    kind: "task-release",
    taskId,
    claimOpId: started.receipt?.opId,
  };
  assert.equal((await fixture.command("node-one", release)).outcome, "applied");
  for (const nodeId of ["node-one", "node-two"]) {
    assert.equal((await fixture.command(nodeId, { kind: "task-start", taskId })).outcome, "applied");
    const current = (await context()).snapshot.lease!;
    assert.equal((await fixture.command("node-one", release)).code, "runtime_terminal_superseded");
    assert.deepEqual((await context()).snapshot.lease, current, "late cleanup must leave the successor lease held");
    assert.equal((await fixture.command(nodeId, { kind: "task-release", taskId })).outcome, "applied");
  }
});

test(
  "edge slot release follows replicated runtime outcome, including terminal replay",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t, [], [], "local", undefined, undefined, false);
    const center = await fixture.center(),
      workspaceRoot = path.join(fixture.root, "edge"),
      viewRoot = path.join(fixture.root, "view");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    const remote = path.join(fixture.root, "origin.git");
    git(fixture.root, "clone", "--bare", "-q", fixture.repo, remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "fetch", "-q", "origin");
    git(fixture.root, "clone", "-q", remote, workspaceRoot);
    const replica = {
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
      readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
    };
    await catchUpReplica(replica);
    applyFleetMirrorCut(viewRoot, fixture.subject.repoId, workspaceRoot, "pull");
    const sync = startResidentReplicaSync(replica);
    t.after(() => sync.close());
    let emit: ((text: string) => void) | undefined, exit: ((code: number | null) => void) | undefined;
    const notified: string[] = [];
    const runtime = openFleetEdgeRuntime({
      request: {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot,
        method: "repo.agentRuntime.spawn",
        action: {},
      },
      readBinding: () => fixture.owners.binding(fixture.subject.nodeId),
      readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
      controlBinding: () => fixture.owners.binding(fixture.subject.nodeId),
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(fixture.root, "edge-user"),
        daemonId: "edge-outcome",
        endpoint: path.join(fixture.root, "edge.sock"),
      },
      ports: scheduleRuntimePorts(),
      onTaskSettled: (taskId) => notified.push(taskId),
      launch: () => ({
        pid: 2_147_483_647,
        onOutput: (listener) => {
          emit = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        terminate: () => undefined,
      }),
    });
    t.after(() => runtime.close());
    const started = await runtime.run("repo.agentRuntime.spawn", {
      taskId: fixture.subject.taskId,
      runtimeInstanceId: definition.instanceId,
      dispatchKey: "terminal-outcome-order",
    });
    const reported = Promise.withResolvers<void>(),
      originalError = console.error;
    t.mock.method(console, "error", (...args: unknown[]) => {
      originalError(...args);
      if (args[0] === "[fleet-edge-runtime] Pending runtime work failed:") reported.resolve();
    });
    const failed = fixture.failNextRuntimeOutcome();
    emit?.(
      `${JSON.stringify({ type: "thread.started", thread_id: "terminal-provider" })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
    );
    exit?.(0);
    await failed;
    await reported.promise;
    const context = await fixture.host.read(
      fixture.subject.repoId,
      "repo.tasks.runtimeContext.read",
      { taskId: fixture.subject.taskId },
      fixture.auth,
    );
    assert.equal(context.snapshot.lease, null);
    assert.deepEqual(notified, [], "a released lease is not yet a published runtime outcome");
    await runtime.reconcile();
    assert.deepEqual(notified, [fixture.subject.taskId]);
    const terminal = await runtime.run("repo.agentRuntime.sessions.read", {
      runtimeSessionId: started.runtimeSessionId,
    });
    assert.notEqual((terminal.session as { activity: { outcome: unknown } }).activity.outcome, null);
  },
);

test(
  "a production edge releases its failed spawn claim and preserves a caller's existing lease",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetNodeClaimFixture(t),
      taskId = "task-spawn-failure";
    assert.equal(
      (
        await fixture.command("node-one", {
          kind: "task-create",
          taskId,
          title: "Failed spawn",
          surfaces: ["artifacts"],
        })
      ).outcome,
      "applied",
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    const remote = path.join(fixture.root, "origin.git");
    git(fixture.root, "clone", "--bare", "-q", fixture.repo, remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "fetch", "-q", "origin");
    const branch = git(fixture.repo, "branch", "--show-current");
    const edge = await fleetEdgeHostFixture(t, fixture, {
      beforeOpen: (root) => {
        git(root, "remote", "add", "origin", remote);
        git(root, "fetch", "-q", "origin");
        git(root, "branch", "--set-upstream-to", `origin/${branch}`);
        git(root, "reset", "--hard", `origin/${branch}`);
      },
    });
    const sync = () =>
      catchUpReplica({
        ...fixture.peer("node-one"),
        ca: readFileSync(path.join(fixture.root, "tls.crt")),
        viewRoot: edge.viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
    await sync();
    const context = () =>
      fixture.host.read("lease-repo", "repo.tasks.runtimeContext.read", { taskId }, localAuthFixture());
    const spawn = (dispatchKey: string) =>
      edge.host.spawnRuntime(
        "lease-repo",
        { taskId, runtimeInstanceId: "missing-instance", dispatchKey },
        localAuthFixture(),
      );
    await assert.rejects(spawn("failed-new-claim"), { code: "runtime_instance_not_found" });
    assert.equal((await context()).snapshot.lease, null);
    assert.equal((await fixture.command("node-one", { kind: "task-start", taskId })).outcome, "applied");
    await sync();
    const held = (await context()).snapshot.lease;
    await assert.rejects(spawn("failed-existing-claim"), { code: "runtime_instance_not_found" });
    assert.deepEqual((await context()).snapshot.lease, held);
  },
);
