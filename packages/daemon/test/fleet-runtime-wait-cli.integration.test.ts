// harness-test-tier: integration
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient, awaitFleetRuntimeSessionsClient } from "../src/fleet/edge.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { eventually } from "./schedule-actions.fixtures.ts";
const replicaQuota = 64 * 1024 * 1024;
for (const scenario of ["status", "foreground", "failed", "cancelled", "reconnect"] as const)
  test(`edge CLI wait: ${scenario}`, { timeout: 60_000 }, async (t) => {
    const foreground = scenario !== "status" && scenario !== "reconnect";
    const expectedOutcome = scenario === "failed" ? "failed" : scenario === "cancelled" ? "cancelled" : "succeeded";
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
    const waitStarted = Promise.withResolvers<void>();
    let awaitRequests = 0;
    const openCenter = (port?: number) =>
      fixture.hold(
        listenFleetTls({
          host: {
            ...fixture.host,
            awaitRuntimeSessions: async (...args) => {
              awaitRequests += 1;
              const waiting = fixture.host.awaitRuntimeSessions(...args);
              waitStarted.resolve();
              return waiting;
            },
          },
          ...fixture.writerOptions,
          stateRoot: fixture.stateRoot,
          key: fixture.key,
          cert: fixture.cert,
          replicaDiskQuotaBytes: replicaQuota,
          ...(port === undefined ? {} : { port }),
          authenticate: (nodeId, credential) => nodeId === fixture.subject.nodeId && credential === "machine-secret",
          nodeOwner: fixture.owners.nodeOwner,

          nodeSubject: fixture.owners.nodeSubject,
        }),
      );
    const center = await openCenter(),
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
    const config = {
      schema: "fleet-edge-config/v1",
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId,
      viewRoot,
      quotaBytes: replicaQuota,
    };
    writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
    managedRbacSessionStore(edgeUserRoot).write(
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: "token-person-owner",
        subject: "person-owner",
        personId: "person-owner",
        expiresAt: Date.now() + 3_600_000,
        roles: [],
        loginTarget: edgeRoot,
        authority: { url: "https://keycloak.example", realm: "harness" },
      }),
    );
    let finish: (() => void) | undefined, cancel: (() => void) | undefined;
    const launchedIn: string[] = [],
      edgeHost = await openDaemonHost({
        daemonId: "fleet-worker-edge",
        userRoot: edgeUserRoot,
        oidc: new OidcSessionService(edgeUserRoot, { fetch: fixture.owners.keycloak.fetch }),
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
              cancel = () => exit(0);
              finish = () => {
                // What a worker does in its cwd: change a repository file and commit it.
                writeFileSync(path.join(prepared.cwd, "delivered.txt"), "delivered\n");
                git(prepared.cwd, "add", "delivered.txt");
                git(prepared.cwd, "commit", "-qm", "feat: edge delivery");
                output?.(
                  `${JSON.stringify({ type: "thread.started", thread_id: "edge-worker-session" })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "edge worker done" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
                );
                exit(scenario === "failed" ? 1 : 0);
              };
            },
            terminate: () => cancel?.(),
          };
        },
      });
    t.after(() => edgeHost.close());
    await edgeHost.attachmentsSettled();
    await edgeHost.runtimeInstance("daemon.runtimeInstance.create", codexInstance, localAuth);
    const transport = createUnixSocketTransportServer({
      daemonId: "fleet-worker-edge",
      socketPath: localUserDaemonEndpoint(edgeUserRoot, "fleet-worker-edge"),
      createProtocolServer: (authContext, emit, _connectionId, connectionSignal) =>
        createJsonRpcProtocolServer({
          host: edgeHost,
          build: { commit: null },
          authContext: { ...authContext, connectionSignal },
          emit,
        }),
    });
    await transport.start();
    t.after(() => transport.stop());
    const invoke = async (args: string[]) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", edgeRoot, "--json", ...args],
        {
          env: { ...env, HARNESS_DAEMON_USER_ROOT: edgeUserRoot, HARNESS_DAEMON_ID: "fleet-worker-edge" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      fixture.track(() => child.kill());
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, stdout, stderr, receipt: JSON.parse(stdout) };
    };
    const launching = invoke([
      "agent",
      "run",
      "edge-worker",
      "--task",
      taskId,
      ...(foreground ? ["--no-stream"] : ["--detach"]),
    ]);
    let receipt;
    if (foreground) {
      await Promise.race([
        waitStarted.promise,
        launching.then((result) => {
          throw new Error(`CLI exited before starting its wait: ${JSON.stringify(result)}`);
        }),
      ]);
      assert.equal(awaitRequests, 1);
      if (scenario === "cancelled") {
        const overview = await fixture.host.read(repoId, "repo.agentRuntime.overview", {}, fixture.auth);
        const cancelled = await invoke(["runtime", "cancel", overview.sessions[0].runtimeSessionId]);
        assert.equal(cancelled.code, 0, JSON.stringify(cancelled));
      } else finish!();
      const launched = await launching;
      assert.equal(launched.code, expectedOutcome === "succeeded" ? 0 : 1, JSON.stringify(launched));
      assert.equal(launched.receipt.outcome, expectedOutcome, JSON.stringify(launched));
      receipt = launched.receipt.spawn;
    } else {
      const launched = await launching;
      receipt = launched.receipt;
      assert.equal(launched.code, 0, JSON.stringify(launched));
      const ordinary = await invoke(["runtime", "status", receipt.runtimeSessionId]);
      assert.equal(ordinary.code, 0, JSON.stringify(ordinary));
      const byDispatch = await fixture.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { taskId, dispatchId: receipt.dispatchId },
        fixture.auth,
      );
      assert.equal(byDispatch.session.runtimeSessionId, receipt.runtimeSessionId);
      await assert.rejects(
        fixture.host.read(
          repoId,
          "repo.agentRuntime.sessions.read",
          { taskId, dispatchId: "dispatch_000000000000000000000000" },
          fixture.auth,
        ),
        { code: "runtime_session_not_found" },
      );
      let waiting = invoke(["runtime", "status", receipt.runtimeSessionId, "--wait", "--no-stream"]);
      await waitStarted.promise;
      assert.equal(awaitRequests, 1);
      if (scenario === "reconnect") {
        await center.close();
        const disconnected = await waiting;
        assert.equal(disconnected.code, 1, JSON.stringify(disconnected));
        assert.equal(disconnected.receipt.ok, false);
        await openCenter(center.port);
        waiting = invoke(["runtime", "status", receipt.runtimeSessionId, "--wait", "--no-stream"]);
      }
      finish!();
      const waited = await waiting;
      assert.equal(waited.code, 0, JSON.stringify(waited));
      assert.equal(waited.receipt.outcome, "succeeded", JSON.stringify(waited));
    }
    await assert.rejects(
      awaitFleetRuntimeSessionsClient({
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "unknown-test-credential",
        repoId,
        method: "repo.agentRuntime.sessions.await",
        payload: { runtimeSessionIds: [receipt.runtimeSessionId] },
      }),
      { code: "authentication_failed" },
    );
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
    assert.equal(await settled(), expectedOutcome, JSON.stringify(fixture.runtimeArchiveReceipts));
  });
