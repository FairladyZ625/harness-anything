// harness-test-tier: integration
import { makeTaskEventReader, type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import assert from "node:assert/strict";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRuntimeSessionDto } from "../src/agent-runtime-contract.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/dispatch-stream.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import {
  fleetFixture,
  git,
  initRepo,
  localAuthFixture,
  rawPeer,
  runFaultChild,
} from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { eventually } from "./schedule-actions.fixtures.ts";
const replicaQuota = 64 * 1024 * 1024;
// A `node --test` timeout suspends the test body at its current await and never resumes it, so `try…finally`
// teardown does not run on the timeout path. Every fixture therefore owns its OS resources and every test hands
// `fixture.close` to `t.after`, which node:test does run after a timeout. Sockets and edge children are dropped
// before the centers so `server.close()` is never left waiting on a peer that outlived the test.
test("fixture teardown reclaims a still-running edge child and its TLS center", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetFixture(t);
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
  const rejected = assert.rejects(pending, /fault edge exited null/u);
  await fixture.close();
  await rejected;
  await assert.rejects(
    rawPeer(fixture.track, center.port, fixture.cert, fixture.assignment.nodeId, "machine-secret"),
    /ECONNREFUSED/u,
  );
});
test(
  "remote-edge runtime launches locally while lifecycle and worker progress settle at center",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
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
      `${JSON.stringify({ schema: "fleet-roster/v3", assignments: [{ assignmentId: fixture.assignment.assignmentId, nodeId: fixture.assignment.nodeId, repoId: fixture.assignment.repoId, viewId: fixture.assignment.viewId, expiresAt: fixture.assignment.expiresAt, scope: { kind: "task", taskId: fixture.assignment.taskId, executionId: fixture.assignment.executionId, paths: fixture.assignment.paths } }] })}
`,
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
                    credential: "machine-secret",
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
        credential: "machine-secret",
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
    assert.deepEqual(readDispatchStream(edgeRoot, String(receipt.dispatchId))?.header.binding?.source, {
      kind: "assignment",
      nodeId: fixture.assignment.nodeId,
      assignmentId: fixture.assignment.assignmentId,
    });
    await taskReleaseBarrier.started;
    await delay(5_100);
    const settlingEvents = makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
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
    assert.equal(
      (await waitForOutcome(receipt.runtimeSessionId))?.session.activity.outcome,
      "succeeded",
      JSON.stringify(fixture.runtimeArchiveReceipts),
    );
    assert.equal(fixture.runtimeArchiveReceipts[0]?.outcome, "applied", JSON.stringify(fixture.runtimeArchiveReceipts));
    const settledEvents = makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo }).read()
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
    assert.deepEqual(
      settledEvents
        .filter(
          (event) =>
            (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
            event.payload.runtimeSessionId === receipt.runtimeSessionId,
        )
        .map((event) => event.actor.executor),
      [
        { kind: "agent", id: `runtime-session:${receipt.runtimeSessionId}` },
        { kind: "agent", id: `runtime-session:${receipt.runtimeSessionId}` },
      ],
      "the center must bind terminal edge writes to their node-owned RuntimeSession",
    );
    const after = await fixture.host.read(fixture.assignment.repoId, "repo.tasks.list", {}, fixture.auth);
    assert.ok(after.sourceRevision > before.sourceRevision);
    await t.test("provider resume recovers when the center loses the outcome publication", async () => {
      const outcomeFailure = fixture.failNextRuntimeOutcome();
      let reportQueueFailure!: () => void;
      const queueFailure = new Promise<void>((resolve) => {
        reportQueueFailure = resolve;
      });
      const originalError = console.error;
      const errorProbe = t.mock.method(console, "error", (...args: unknown[]) => {
        originalError(...args);
        if (String(args[0]).includes("[fleet-edge-runtime] Pending runtime work failed:")) reportQueueFailure();
      });
      const resumed = await edgeHost.fleet.edgeRuntime(
        {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId: fixture.assignment.nodeId,
          credential: "machine-secret",
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
      assert.equal(typeof resumed.runtimeSessionId, "string", JSON.stringify(resumed));
      await outcomeFailure;
      await queueFailure;
      errorProbe.mock.restore();
      const partial = makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
        .read()
        .events.filter(
          (event) =>
            (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
            event.payload.runtimeSessionId === resumed.runtimeSessionId,
        );
      assert.deepEqual(
        partial.map((event) => event.type),
        ["runtime_session_exited"],
      );
      const partialSession = await fixture.host.read(
        fixture.assignment.repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: resumed.runtimeSessionId },
        fixture.auth,
      );
      assert.deepEqual(
        {
          liveness: partialSession.session.liveness,
          outcome: partialSession.session.activity.outcome,
          lease: partialSession.session.associations.find((item) => item.taskId === fixture.assignment.taskId)?.lease
            ?.phase,
        },
        { liveness: "exited", outcome: null, lease: "released" },
        "the accepted exit and released task lease stay authoritative while outcome is missing",
      );

      await edgeHost.fleet.edgeRuntime(
        {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId: fixture.assignment.nodeId,
          credential: "machine-secret",
          rosterPath,
          assignmentId: fixture.assignment.assignmentId,
          repoId: fixture.assignment.repoId,
          viewRoot,
          quotaBytes: replicaQuota,
          workspaceRoot: edgeRoot,
          method: "repo.agentRuntime.overview",
          action: { limit: 1 },
        },
        localAuth,
      );
      const recoveredSession = await waitForOutcome(resumed.runtimeSessionId);
      assert.deepEqual(
        {
          liveness: recoveredSession?.session.liveness,
          outcome: recoveredSession?.session.activity.outcome,
        },
        { liveness: "exited", outcome: "succeeded" },
        "a supported edge request should recover the outcome after the center accepted exited",
      );
      assert.match(String(recoveredSession?.session.activity.resultRef), /^artifact:runtime-result\/sha256\//u);
      assert.equal(
        recoveredSession?.session.associations.find((item) => item.taskId === fixture.assignment.taskId)?.lease?.phase,
        "released",
      );
      const settled = makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
        .read()
        .events.filter(
          (event) =>
            (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
            event.payload.runtimeSessionId === resumed.runtimeSessionId,
        );
      assert.deepEqual(
        settled.map((event) => event.type),
        ["runtime_session_exited", "runtime_session_outcome_observed"],
        "retrying an applied exited op must not duplicate terminal events",
      );
      assert.equal(launchedInstances.at(-1), runtimeDefinition.instanceId);
    });
    await t.test("another assignment cannot replay terminal events for this runtime session", async () => {
      const foreignAssignment = {
          ...fixture.assignment,
          nodeId: "node-two",
          assignmentId: "assignment-two",
          viewId: "node-two_task-fleet",
        },
        events = makeTaskEventReader({ repoId: fixture.assignment.repoId, rootDir: fixture.repo })
          .read()
          .events.filter(
            (event) =>
              (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          );
      assert.equal(events.length, 2);
      for (const event of events) {
        const rejected = await fixture.host.runtimeIngress(
          fixture.assignment.repoId,
          { kind: "event", type: event.type, payload: event.payload, opId: event.opId },
          fixture.owners.auth(foreignAssignment),
        );
        assert.equal(rejected.outcome, "op_rejected");
        assert.equal(rejected.code, "assignment_scope_mismatch");
      }
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
    assert.equal(existsSync(dispatchStreamPath(edgeRoot, receipt.dispatchId)), true);
    assert.equal(existsSync(dispatchStreamPath(fixture.repo, receipt.dispatchId)), false);
    assert.equal(
      readFileSync(
        path.join(edgeRoot, "harness/tasks/task-fleet-fleet/artifacts/reports", `${receipt.dispatchId}.md`),
        "utf8",
      ).includes("edge runtime done"),
      true,
      "the accepted center archive must be recoverable through the edge mirror",
    );
  },
);
test(
  "an edge dispatches a center-installed worker into the task's own worktree and settlement publishes its branch",
  { timeout: 60_000 },
  async (t) => {
    const installation: RuntimeInstallationWitness = {
        installationId: "edge-codex-installation",
        kindId: "codex",
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      codexInstance = {
        instanceId: "edge-codex",
        name: "Edge Codex",
        kindId: installation.kindId,
        installationId: installation.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        codex: { reasoningEffort: "high" },
        authMode: "subscription",
      },
      fixture = await fleetFixture(t, ["tasks/task-fleet-fleet", "agents"], [installation]);
    t.after(() => fixture.close());
    await fixture.host.runtimeInstance("daemon.runtimeInstance.create", codexInstance, localAuthFixture());
    const { repoId, taskId } = fixture.assignment,
      // The Agent is installed at the center only; the edge has no ledger and reads it from its mirrored view.
      packageSource = path.join(fixture.repo, "source", "edge-worker");
    mkdirSync(packageSource, { recursive: true });
    writeFileSync(
      path.join(packageSource, "agent.json"),
      `${JSON.stringify({
        schema: "agent-declaration/v1",
        id: "edge-worker",
        name: "Edge Worker",
        instructions: "Deliver the task in its worktree.",
        runtimes: [{ type: "codex" }],
        role: "worker",
      })}\n`,
    );
    const installed = await fixture.host.run(
      repoId,
      { kind: "agent-install", packageSource, expectedVersion: 0, idempotencyKey: "edge-worker-install" },
      localAuthFixture(),
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    await waitForFleetPublication(fixture.host, repoId, installed.opId, localAuthFixture());
    const center = await fixture.center(),
      edgeRoot = path.join(fixture.root, "worker-edge"),
      edgeUserRoot = path.join(fixture.root, "worker-edge-user"),
      viewRoot = path.join(fixture.root, "worker-edge-view"),
      rosterPath = path.join(fixture.root, "worker-roster.json"),
      remote = path.join(fixture.root, "worker-remote.git"),
      localAuth = localAuthFixture();
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: worker-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");
    git(fixture.root, "init", "--bare", "-q", remote);
    git(edgeRoot, "remote", "add", "origin", remote);
    git(edgeRoot, "push", "-q", "-u", "origin", git(edgeRoot, "branch", "--show-current"));
    const base = git(edgeRoot, "rev-parse", "HEAD");
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    assert.equal(existsSync(path.join(edgeRoot, "harness/agents/edge-worker.json")), true);
    writeFileSync(
      rosterPath,
      `${JSON.stringify({ schema: "fleet-roster/v3", assignments: [{ assignmentId: fixture.assignment.assignmentId, nodeId: fixture.assignment.nodeId, repoId, viewId: fixture.assignment.viewId, expiresAt: fixture.assignment.expiresAt, scope: { kind: "task", taskId, executionId: fixture.assignment.executionId, paths: fixture.assignment.paths } }] })}\n`,
    );
    registerDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    const launchedIn: string[] = [],
      edgeHost = await openDaemonHost({
        daemonId: "fleet-worker-edge",
        userRoot: edgeUserRoot,
        runtimeDiscover: () => [installation],
        runtimeLaunch: (prepared) => {
          launchedIn.push(prepared.cwd);
          let output: ((chunk: string) => void) | null = null;
          return {
            pid: 90310,
            onOutput: (listener) => {
              output = listener;
            },
            onErrorOutput: () => undefined,
            onExit: (exit) => {
              queueMicrotask(() => {
                // What a worker does in its cwd: change a repository file and commit it.
                writeFileSync(path.join(prepared.cwd, "delivered.txt"), "delivered\n");
                git(prepared.cwd, "add", "delivered.txt");
                git(prepared.cwd, "commit", "-qm", "feat: edge delivery");
                output?.(
                  `${JSON.stringify({ type: "thread.started", thread_id: "edge-worker-session" })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "edge worker done" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
                );
                exit(0);
              });
            },
            terminate: () => undefined,
          };
        },
      });
    t.after(() => edgeHost.close());
    await edgeHost.attachmentsSettled();
    await edgeHost.runtimeInstance("daemon.runtimeInstance.create", codexInstance, localAuth);
    const receipt = await edgeHost.fleet.edgeRuntime(
      {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.assignment.nodeId,
        credential: "machine-secret",
        rosterPath,
        assignmentId: fixture.assignment.assignmentId,
        repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: { agentId: "edge-worker", taskId, idempotencyKey: "remote-edge-worker" },
      },
      localAuth,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const worktree = path.join(edgeRoot, ".worktrees", taskId);
    assert.deepEqual(launchedIn, [worktree], "the worker runs in the task's worktree, not the node's main checkout");
    const settled = async () =>
      (
        await fixture.host.read(
          repoId,
          "repo.agentRuntime.sessions.read",
          { runtimeSessionId: receipt.runtimeSessionId },
          fixture.auth,
        )
      ).session.activity.outcome;
    assert.equal(await eventually(async () => (await settled()) !== null), true);
    assert.equal(await settled(), "succeeded", JSON.stringify(fixture.runtimeArchiveReceipts));
    const delivered = git(worktree, "rev-parse", "HEAD");
    assert.notEqual(delivered, base);
    assert.equal(git(remote, "rev-parse", `refs/heads/${taskId}`), delivered, "the commit reaches the shared remote");
    assert.equal(git(edgeRoot, "rev-parse", "HEAD"), base, "the node's main checkout is untouched");
    assert.match(
      readFileSync(
        path.join(fixture.repo, "harness/tasks/task-fleet-fleet/artifacts/reports", `${receipt.dispatchId}.md`),
        "utf8",
      ),
      new RegExp(`Worker branch pushed at settlement: ${taskId} @ ${delivered}`, "u"),
      "the center's dispatch report names the published commit",
    );
  },
);
test("remote-edge runtime retries startup adoption after the center recovers", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const initialCenter = await fixture.center(),
    unavailablePort = initialCenter.port;
  await initialCenter.close();
  const workspaceRoot = path.join(fixture.root, "startup-recovery-edge");
  mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: startup-recovery-edge\n" +
      "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  const runtime = openFleetEdgeRuntime({
    request: {
      host: "127.0.0.1",
      port: unavailablePort,
      caPath: fixture.certFile,
      nodeId: fixture.assignment.nodeId,
      credential: "machine-secret",
      assignmentId: fixture.assignment.assignmentId,
      repoId: fixture.assignment.repoId,
      viewRoot: path.join(fixture.root, "startup-recovery-view"),
      quotaBytes: replicaQuota,
      workspaceRoot,
      method: "repo.agentRuntime.overview",
      action: { limit: 1 },
    },
    daemonGeneration: 1,
    daemonRoute: {
      userRoot: path.join(fixture.root, "startup-recovery-user"),
      daemonId: "startup-recovery-edge",
      endpoint: path.join(fixture.root, "startup-recovery.sock"),
    },
    ports: {
      runtimeInstances: () => [],
      prepareRuntimeLaunch: async () => {
        throw new Error("runtime launch is not part of startup recovery");
      },
    },
  });
  fixture.track(() => runtime.close());
  await assert.rejects(
    runtime.run("repo.agentRuntime.overview", { limit: 1 }),
    (error: unknown) =>
      /ECONNREFUSED/u.test(String((error as Error).message)) ||
      String((error as { readonly code?: unknown }).code) === "ECONNREFUSED",
  );

  await fixture.center(unavailablePort);
  const recovered = await runtime.run("repo.agentRuntime.overview", { limit: 1 });
  assert.equal((recovered.sessions as readonly unknown[]).length, 0);

  const concurrent = await Promise.all([
    runtime.run("repo.agentRuntime.overview", { limit: 1 }),
    runtime.run("repo.agentRuntime.overview", { limit: 1 }),
  ]);
  assert.equal(concurrent.length, 2);
  assert.ok(concurrent.every((result) => Array.isArray(result.sessions)));
});
test("fleet runtime waits over five seconds for every configured overview page", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
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
      definitionSnapshotPersisted: false,
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
        missingEvidence: null,
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
  const center = await fixture.hold(
    listenFleetTls({
      host: slowHost,
      ...fixture.writerOptions,
      stateRoot: path.join(fixture.root, "slow-runtime-center"),
      key: fixture.key,
      cert: fixture.cert,
      replicaDiskQuotaBytes: replicaQuota,
      authenticate: (nodeId, credential) => nodeId === fixture.assignment.nodeId && credential === "machine-secret",
      nodeOwner: fixture.owners.nodeOwner,
      resolveAssignment: (assignmentId) =>
        assignmentId === fixture.assignment.assignmentId ? fixture.assignment : null,
    }),
  );
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
  fixture.track(() => void runtime.close());
  const overview = await runtime.run("repo.agentRuntime.overview", { limit: 1 });
  assert.equal((overview.sessions as readonly unknown[]).length, 1);
  assert.deepEqual(pagePayloads.slice(0, 2), [{ limit: 16 }, { limit: 16, cursor: "slow-page:16" }]);
  assert.equal(responseWaits.length, 3);
  assert.equal(
    responseWaits.every((elapsed) => elapsed >= 5_000),
    true,
  );
});
