// harness-test-tier: integration
import { makeTaskEventReader, type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import assert from "node:assert/strict";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/dispatch-stream.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime, readFleetRuntimeSessionsPaged } from "../src/fleet-edge-runtime.ts";
import { runFleetEdgeTask } from "../src/fleet-edge-task.ts";
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
import { eventually, scheduleRuntimePorts, definition } from "./schedule-actions.fixtures.ts";
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
    nodeId: fixture.subject.nodeId,
    credential: "machine-secret",
    repoId: fixture.subject.repoId,
    executionId: fixture.subject.executionId,
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
    rawPeer(fixture.track, center.port, fixture.cert, fixture.subject.nodeId, "machine-secret"),
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
      uid = process.getuid?.() ?? 0,
      localAuth = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
      } as const;
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      readFileSync(path.join(fixture.repo, "harness/harness.yaml")),
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    assert.equal(applyFleetMirrorCut(viewRoot, fixture.subject.repoId, edgeRoot, "pull").outcome, "applied");
    registerDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.subject.repoId,
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
      before = await fixture.host.read(fixture.subject.repoId, "repo.tasks.list", {}, fixture.auth),
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
                    nodeId: fixture.subject.nodeId,
                    credential: "machine-secret",
                    repoId: fixture.subject.repoId,
                    viewRoot,
                    quotaBytes: replicaQuota,
                    workspaceRoot: edgeRoot,
                    action: {
                      kind: "task-progress-append",
                      taskId: fixture.subject.taskId,
                      executionId: fixture.subject.executionId,
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
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot: edgeRoot,
        method: "repo.agentRuntime.spawn",
        action: {
          runtimeInstanceId: runtimeDefinition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Append one progress checkpoint.",
          taskId: fixture.subject.taskId,
          idempotencyKey: "remote-edge-runtime",
        },
      },
      localAuth,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(launchedEnv?.HARNESS_DAEMON_USER_ROOT, edgeUserRoot);
    assert.equal(launchedEnv?.HARNESS_DAEMON_ID, "fleet-runtime-edge");
    assert.equal(launchedEnv?.HARNESS_DAEMON_REPO_ID, fixture.subject.repoId);
    assert.ok(launchedEnv?.HARNESS_EXECUTION_CREDENTIAL, "edge task worker requires its dispatch credential");
    assert.deepEqual(readDispatchStream(edgeRoot, String(receipt.dispatchId))?.header.binding?.source, {
      kind: "node",
      nodeId: fixture.subject.nodeId,
    });
    await taskReleaseBarrier.started;
    await delay(5_100);
    const settlingEvents = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
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
            fixture.subject.repoId,
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
    // The mocked repo-root worker makes no delivery the edge could witness, so its settlement
    // stays unknown; a zero exit plus a result reference no longer restates success.
    assert.equal(
      (await waitForOutcome(receipt.runtimeSessionId))?.session.activity.outcome,
      "unknown",
      JSON.stringify(fixture.runtimeArchiveReceipts),
    );
    assert.equal(fixture.runtimeArchiveReceipts[0]?.outcome, "applied", JSON.stringify(fixture.runtimeArchiveReceipts));
    const settledEvents = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo }).read().events,
      leaseReleaseIndex = settledEvents.findIndex(
        (event) => event.type === "lease_released" && event.taskId === fixture.subject.taskId,
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
    const after = await fixture.host.read(fixture.subject.repoId, "repo.tasks.list", {}, fixture.auth);
    assert.ok(after.sourceRevision > before.sourceRevision);
    await t.test("provider resume recovers when the center loses the outcome publication", async () => {
      // A retained provider session does not retain the terminal attempt's released task lease.
      const rejoined = await fixture.host.run(
        fixture.subject.repoId,
        { kind: "task-start", taskId: fixture.subject.taskId, executionId: fixture.subject.executionId },
        fixture.auth,
      );
      assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
      await waitForFleetPublication(fixture.host, fixture.subject.repoId, rejoined.opId, fixture.auth);
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
          nodeId: fixture.subject.nodeId,
          credential: "machine-secret",
          repoId: fixture.subject.repoId,
          viewRoot,
          quotaBytes: replicaQuota,
          workspaceRoot: edgeRoot,
          method: "repo.agentRuntime.spawn",
          action: {
            dispatchId: receipt.dispatchId,
            cwd: { scope: "repo-root" },
            prompt: "Resume on the original runtime instance.",
            taskId: fixture.subject.taskId,
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
      const partial = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
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
        fixture.subject.repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: resumed.runtimeSessionId },
        fixture.auth,
      );
      assert.deepEqual(
        {
          liveness: partialSession.session.liveness,
          outcome: partialSession.session.activity.outcome,
          lease: partialSession.session.associations.find((item) => item.taskId === fixture.subject.taskId)?.lease
            ?.phase,
        },
        { liveness: "exited", outcome: null, lease: "released" },
        "the accepted exit and released task lease stay authoritative while outcome is missing",
      );

      // Public queries require a repository principal and cannot drive recovery writes.
      await assert.rejects(
        edgeHost.read(fixture.subject.repoId, "repo.agentRuntime.overview", { limit: 1 }, localAuth),
        { code: "authentication_required" },
      );
      // The supported sync path reconciles with node authority, without an interactive login.
      const sync = await edgeHost.fleet.edgeSync(
        {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId: fixture.subject.nodeId,
          credential: "machine-secret",
          repoId: fixture.subject.repoId,
          viewRoot,
          quotaBytes: replicaQuota,
          workspaceRoot: edgeRoot,
        },
        localAuth,
      );
      assert.equal(sync.outcome, "applied", JSON.stringify(sync));
      const recoveredSession = await waitForOutcome(resumed.runtimeSessionId);
      assert.deepEqual(
        {
          liveness: recoveredSession?.session.liveness,
          outcome: recoveredSession?.session.activity.outcome,
        },
        // The recovered verdict is the settled unknown: no delivery was witnessed on the edge,
        // and recovery restores the published outcome rather than restating success.
        { liveness: "exited", outcome: "unknown" },
        "edge sync without an interactive login recovers the outcome after the center accepted exited",
      );
      assert.match(String(recoveredSession?.session.activity.resultRef), /^artifact:runtime-result\/sha256\//u);
      assert.equal(
        recoveredSession?.session.associations.find((item) => item.taskId === fixture.subject.taskId)?.lease?.phase,
        "released",
      );
      const settled = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
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
    await t.test("another node cannot replay terminal events for this runtime session", async () => {
      const foreignSubject = {
          ...fixture.subject,
          nodeId: "node-two",
          viewId: "node-two_task-fleet",
        },
        events = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo })
          .read()
          .events.filter(
            (event) =>
              (event.type === "runtime_session_exited" || event.type === "runtime_session_outcome_observed") &&
              event.payload.runtimeSessionId === receipt.runtimeSessionId,
          );
      assert.equal(events.length, 2);
      for (const event of events) {
        await assert.rejects(
          fixture.host.runtimeIngress(
            fixture.subject.repoId,
            { kind: "event", type: event.type, payload: event.payload, opId: event.opId },
            fixture.owners.auth(foreignSubject),
          ),
          { code: "execution_credential_rejected" },
        );
      }
    });
    await runFleetReplicaPullClient({
      port: center.port,
      ca: fixture.cert,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, fixture.subject.repoId, edgeRoot, "pull");
    const mirrored = locateFleetMirrorView(viewRoot, fixture.subject.repoId);
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
  "an edge dispatches into its task worktree without publishing unsubmitted commits at settlement",
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
    const { repoId, taskId } = fixture.subject,
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
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      viewRoot,
      diskQuotaBytes: replicaQuota,
    });
    applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    assert.equal(existsSync(path.join(edgeRoot, "harness/agents/edge-worker.json")), true);
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
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
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
    assert.equal(
      git(remote, "for-each-ref", "--format=%(refname)", `refs/heads/${taskId}`),
      "",
      "a successful worker exit cannot publish an unsubmitted delivery",
    );
    assert.equal(git(edgeRoot, "rev-parse", "HEAD"), base, "the node's main checkout is untouched");
    assert.doesNotMatch(
      readFileSync(
        path.join(fixture.repo, "harness/tasks/task-fleet-fleet/artifacts/reports", `${receipt.dispatchId}.md`),
        "utf8",
      ),
      /Worker branch pushed at settlement:/u,
      "the center's dispatch report cannot claim an unperformed publication",
    );
  },
);
test("remote-edge control retries startup adoption after the center recovers", { timeout: 60_000 }, async (t) => {
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
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
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
      prepareWorkerGitEnvironment: async () => null,
    },
  });
  fixture.track(() => runtime.close());
  await assert.rejects(runtime.run("repo.agentRuntime.overview", { limit: 1 }), { code: "replica_unavailable" });
  const awaitMissing = () => runtime.run("repo.agentRuntime.sessions.await", { runtimeSessionIds: ["missing"] });
  await assert.rejects(
    awaitMissing(),
    (error: unknown) =>
      /ECONNREFUSED/u.test(String((error as Error).message)) ||
      String((error as { readonly code?: unknown }).code) === "ECONNREFUSED",
  );

  await fixture.center(unavailablePort);
  const concurrent = await Promise.all([awaitMissing(), awaitMissing()]);
  assert.equal(concurrent.length, 2);
  for (const result of concurrent) {
    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.unavailable, [{ runtimeSessionId: "missing", code: "runtime_session_not_found" }]);
  }
  const recovered = await runtime.run("repo.agentRuntime.overview", { limit: 1 });
  assert.deepEqual(recovered.sessions, []);
  assert.ok(recovered.cut, "successful control preparation materializes the owner-bound read cut");
});
test(
  "fleet runtime pages every session from an owner-bound replica while the center is offline",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const center = await fixture.center(),
      workspaceRoot = path.join(fixture.root, "paged-runtime-edge"),
      viewRoot = path.join(fixture.root, "paged-runtime-view");
    mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: paged-runtime-edge\n" +
        "layout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const runtime = openFleetEdgeRuntime({
      request: {
        host: "127.0.0.1",
        port: center.port,
        caPath: fixture.certFile,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        quotaBytes: replicaQuota,
        workspaceRoot,
        method: "repo.agentRuntime.spawn",
        action: {},
      },
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(fixture.root, "paged-runtime-user"),
        daemonId: "paged-runtime-edge",
        endpoint: path.join(fixture.root, "paged-runtime.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: () => ({
        pid: 90210,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    fixture.track(() => runtime.close());
    const sessionIds: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const launched = await runtime.run("repo.agentRuntime.spawn", {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Remain active for the replica pagination probe.",
        idempotencyKey: `replica-page-${index}`,
      });
      assert.equal(launched.outcome, "applied", JSON.stringify(launched));
      sessionIds.push(String(launched.runtimeSessionId));
    }
    await runtime.reconcile();
    await center.close();
    const payloads: Record<string, unknown>[] = [],
      pageSizes: number[] = [];
    const sessions = await readFleetRuntimeSessionsPaged(async (payload) => {
      payloads.push(payload);
      const result = await runtime.run("repo.agentRuntime.overview", payload);
      assert.ok(result.cut);
      assert.ok(result.freshness);
      pageSizes.push((result.sessions as unknown[]).length);
      return result;
    });
    assert.deepEqual(sessions.map((session) => session.runtimeSessionId).sort(), sessionIds.sort());
    assert.deepEqual(pageSizes, [16, 1], "read through the terminal page exactly once");
    assert.deepEqual(payloads, [
      { limit: 16 },
      { limit: 16, cursor: `runtime-session:${sessions[15]!.runtimeSessionId}` },
    ]);
    const detail = await runtime.run("repo.agentRuntime.sessions.read", {
      runtimeSessionId: sessions[16]!.runtimeSessionId,
    });
    assert.equal((detail.session as { runtimeSessionId: string }).runtimeSessionId, sessions[16]!.runtimeSessionId);
    t.diagnostic(
      `offline replica: ${sessions.length} sessions, pages=${pageSizes.join("+")}, detail=${sessions[16]!.runtimeSessionId}`,
    );
  },
);
