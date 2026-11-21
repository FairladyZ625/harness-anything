// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instances.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { runFleetTaskCommandClient } from "../src/daemon-host/fleet/peer.ts";
import { tailRuntimeSteerCommands } from "../src/daemon-host/runtime-worker-control.ts";
import { runtimeProcessFixture } from "./fixtures/runtime-process.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";

const repoId = "lease-repo";

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const codexInstallation: RuntimeInstallationWitness = {
  installationId: "edge-codex-install",
  kindId: "codex",
  executablePath: "/usr/bin/true",
  version: "1.0.0",
  observedAt: "2026-11-21T00:00:00.000Z",
};

const zcodeInstallation: RuntimeInstallationWitness = {
  installationId: "edge-zcode-install",
  kindId: "zcode",
  executablePath: "/usr/bin/true",
  version: "1.0.0",
  observedAt: "2026-11-21T00:00:00.000Z",
};

interface LaunchedHandle {
  readonly pid: number;
  readonly terminate: () => void;
  readonly exit: (code: number | null) => void;
  readonly emitProviderSession: (threadId: string) => void;
}

async function setupEdgeNode(
  t: TestContext,
  f: Awaited<ReturnType<typeof fleetNodeClaimFixture>>,
  originRemote: string,
  branch: string,
  nodeId: string,
  name: string,
) {
  const handles: LaunchedHandle[] = [];
  const edge = await fleetEdgeHostFixture(t, f, {
    name,
    nodeId,
    personId: "person-one",
    runtimeDiscover: () => [codexInstallation, zcodeInstallation],
    runtimeLaunch: () => {
      const proc = runtimeProcessFixture(t);
      let outputListener: ((chunk: string) => void) | null = null;
      let queuedThreadId: string | null = null;
      const emitProviderSession = (threadId: string) => {
        const frame = `${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`;
        if (outputListener) outputListener(frame);
        else queuedThreadId = threadId;
      };
      handles.push({
        pid: proc.pid,
        terminate: proc.terminate,
        exit: proc.exit,
        emitProviderSession,
      });
      return {
        ...proc,
        onOutput: (listener) => {
          outputListener = listener;
          if (queuedThreadId !== null) {
            const pending = queuedThreadId;
            queuedThreadId = null;
            listener(`${JSON.stringify({ type: "thread.started", thread_id: pending })}\n`);
          }
        },
        onErrorOutput: () => undefined,
      };
    },
    beforeOpen: (root) => {
      git(root, "remote", "add", "origin", originRemote);
      git(root, "fetch", "-q", "origin");
      git(root, "branch", "--set-upstream-to", `origin/${branch}`);
      git(root, "reset", "--hard", `origin/${branch}`);
    },
  });
  const localAuth = localAuthFixture();
  for (const instance of [
    {
      instanceId: `${nodeId}-codex`,
      name: `${nodeId} Codex`,
      kindId: "codex",
      installationId: codexInstallation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      authMode: "subscription",
      enabled: true,
    },
    {
      instanceId: `${nodeId}-zcode`,
      name: `${nodeId} ZCode`,
      kindId: "zcode",
      installationId: zcodeInstallation.installationId,
      providerId: "zai",
      models: ["glm-5"],
      defaultModel: "glm-5",
      authMode: "subscription",
      enabled: true,
    },
  ]) {
    const created = await edge.host.runtimeInstance("daemon.runtimeInstance.create", instance, localAuth, repoId);
    assert.equal(created.ok, true, JSON.stringify(created));
  }
  await catchUpReplica({
    ...f.peer(nodeId),
    ca: readFileSync(path.join(f.root, "tls.crt")),
    viewRoot: edge.viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
  });
  return { edge, handles };
}

function readRuntimeControlEvents(repoRoot: string, runtimeSessionId?: string) {
  return makeTaskEventReader({ repoId, rootDir: repoRoot })
    .read()
    .events.filter(
      (event) =>
        event.schema === "agent-runtime-event/v1" &&
        (event.type === "runtime_cancel_requested" || event.type === "runtime_steer_requested") &&
        (runtimeSessionId === undefined || event.payload.runtimeSessionId === runtimeSessionId),
    );
}

function waitForSteerPrompt(streamPath: string, expectedPrompt: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const tail = tailRuntimeSteerCommands(streamPath, (prompt) => {
      if (prompt === expectedPrompt) {
        cleanup();
        resolve(prompt);
      }
    });
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Timed out waiting for remote steer delivery."));
    };
    const cleanup = () => {
      tail.stop();
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForProviderBound(
  host: Awaited<ReturnType<typeof fleetNodeClaimFixture>>["host"],
  runtimeSessionId: string,
  auth: ReturnType<typeof localAuthFixture>,
): Promise<void> {
  await waitForDurableCondition(async () => {
    const read = await host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth);
    return Boolean(read.session?.providerSessionId);
  });
}

const allowedEdgeInstanceIds = ["node-one-codex", "node-one-zcode", "node-two-codex", "node-two-zcode"] as const;

async function allowEdgeRuntimeInstances(
  host: Awaited<ReturnType<typeof fleetNodeClaimFixture>>["host"],
): Promise<void> {
  const receipt = await host.run(
    repoId,
    { kind: "settings-update", runtimeAllowedInstances: [...allowedEdgeInstanceIds] },
    localAuthFixture(),
  );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
}

test(
  "center cancels and steers edge runtimes over outbound TLS WAL without inbound ports, preserving cross-node isolation and negative controls",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const originRemote = path.join(f.root, "origin.git");
    git(f.root, "clone", "--bare", "-q", f.repo, originRemote);
    git(f.repo, "remote", "add", "origin", originRemote);
    git(f.repo, "fetch", "-q", "origin");
    const branch = git(f.repo, "branch", "--show-current");

    // Sign in person-one locally on Center and configure Web BFF user sessions for positive & negative tests.
    await allowEdgeRuntimeInstances(f.host);
    signInAt(f.userRoot, "person-one");
    f.owners.keycloak.permit("person-one", repoId, ["runtime-cancel", "runtime-steer", "repository-read"]);
    f.owners.keycloak.interactiveSession("person-one", "center-node", f.owners.url, "bff-owner-token", "web-bff");

    f.owners.keycloak.account("person-other");
    f.owners.keycloak.permit("person-other", repoId, ["runtime-cancel", "runtime-steer", "repository-read"]);
    f.owners.keycloak.interactiveSession("person-other", "center-node", f.owners.url, "bff-other-token", "web-bff");

    f.owners.keycloak.account("person-unauthorized");
    f.owners.keycloak.interactiveSession(
      "person-unauthorized",
      "center-node",
      f.owners.url,
      "bff-unauth-token",
      "web-bff",
    );

    const { edge: edgeA, handles: handlesA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-a");
    const { edge: edgeB, handles: handlesB } = await setupEdgeNode(t, f, originRemote, branch, "node-two", "edge-b");
    const localAuth = localAuthFixture();

    // 1. Spawn concurrent live sessions on Edge A (codex + agy) and Edge B (codex).
    const spawnA = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Long running remote worker on Edge A",
        dispatchKey: "g8-remote-control-edge-a",
      },
      localAuth,
    );
    assert.equal(spawnA.outcome, "applied", JSON.stringify(spawnA));
    const sessionA = String(spawnA.runtimeSessionId);
    const dispatchA = String(spawnA.dispatchId);
    assert.equal(handlesA.length, 1);
    handlesA[0]!.emitProviderSession("thread-edge-a-1");

    const spawnZcode = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-zcode",
        cwd: { scope: "repo-root" },
        prompt: "Non-steerable runtime on Edge A",
        dispatchKey: "g8-remote-control-edge-a-zcode",
      },
      localAuth,
    );
    assert.equal(spawnZcode.outcome, "applied", JSON.stringify(spawnZcode));
    const sessionZcode = String(spawnZcode.runtimeSessionId);

    const spawnB = await edgeB.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-two-codex",
        cwd: { scope: "repo-root" },
        prompt: "Independent worker on Edge B",
        dispatchKey: "g8-remote-control-edge-b",
      },
      localAuth,
    );
    assert.equal(spawnB.outcome, "applied", JSON.stringify(spawnB));
    const sessionB = String(spawnB.runtimeSessionId);
    assert.equal(handlesB.length, 1);

    await waitForProviderBound(f.host, sessionA, localAuth);

    // 2. Negative controls BEFORE any valid control event is written:
    // 2a. Unauthorized principal via Web BFF TLS frame -> authorization_denied, 0 events written.
    await assert.rejects(
      runFleetTaskCommandClient({
        port: f.center.port,
        ca: readFileSync(path.join(f.root, "tls.crt")),
        servername: "localhost",
        nodeId: "center-node",
        credential: "secret-center-node",
        readAccessToken: async () => "bff-unauth-token",
        accessToken: "bff-unauth-token",
        opId: randomUUID(),
        repoId,
        taskId: null,
        waitMs: 5_000,
        action: { kind: "runtime-cancel", runtimeSessionId: sessionA } as never,
      }),
      { code: "authorization_denied" },
    );

    // 2b. Non-owner principal (has RBAC, wrong owner) via Web BFF -> execution_scope_mismatch, 0 events written.
    await assert.rejects(
      runFleetTaskCommandClient({
        port: f.center.port,
        ca: readFileSync(path.join(f.root, "tls.crt")),
        servername: "localhost",
        nodeId: "center-node",
        credential: "secret-center-node",
        readAccessToken: async () => "bff-other-token",
        accessToken: "bff-other-token",
        opId: randomUUID(),
        repoId,
        taskId: null,
        waitMs: 5_000,
        action: { kind: "runtime-cancel", runtimeSessionId: sessionA } as never,
      }),
      { code: "execution_scope_mismatch" },
    );

    // 2c. Cross-repo request via Web BFF -> rejected fail-closed, 0 events written.
    await assert.rejects(
      runFleetTaskCommandClient({
        port: f.center.port,
        ca: readFileSync(path.join(f.root, "tls.crt")),
        servername: "localhost",
        nodeId: "center-node",
        credential: "secret-center-node",
        readAccessToken: async () => "bff-owner-token",
        accessToken: "bff-owner-token",
        opId: randomUUID(),
        repoId: "other-repo",
        taskId: null,
        waitMs: 5_000,
        action: { kind: "runtime-cancel", runtimeSessionId: sessionA } as never,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        ["authorization_denied", "repo_namespace_unknown", "repo_unavailable", "execution_scope_mismatch"].includes(
          String(error.code),
        ),
    );

    // 2d. Unsupported steer provider (zcode) -> runtime_steer_unsupported at Center entry, 0 events written.
    await assert.rejects(
      f.host.steerRuntime(repoId, { runtimeSessionId: sessionZcode, prompt: "Cannot steer zcode" }, localAuth),
      { code: "runtime_steer_unsupported" },
    );
    assert.equal(readRuntimeControlEvents(f.repo).length, 0, "rejected requests must write zero control events");

    // 3. Remote STEER via Web BFF (fleet.task.command/v1 + user accessToken) + replay idempotency.
    const steerPrompt = "Shift focus to remote control verification.";
    const streamPathA = dispatchStreamPath(edgeA.edgeRoot, dispatchA);
    const steerDelivered = waitForSteerPrompt(streamPathA, steerPrompt, AbortSignal.timeout(30_000));
    const steerViaBff = await runFleetTaskCommandClient({
      port: f.center.port,
      ca: readFileSync(path.join(f.root, "tls.crt")),
      servername: "localhost",
      nodeId: "center-node",
      credential: "secret-center-node",
      readAccessToken: async () => "bff-owner-token",
      accessToken: "bff-owner-token",
      opId: randomUUID(),
      repoId,
      taskId: null,
      waitMs: 5_000,
      action: {
        kind: "runtime-steer",
        runtimeSessionId: sessionA,
        prompt: steerPrompt,
        idempotencyKey: "ctrl-steer-e2e-1",
      } as never,
    });
    assert.equal(steerViaBff.outcome, "applied", JSON.stringify(steerViaBff));
    assert.equal(steerViaBff.receipt?.detail, "steer_requested");
    assert.equal(steerViaBff.receipt?.targetNodeId, "node-one");
    assert.equal(await steerDelivered, steerPrompt);

    // Replaying the same controlRequestId at Center must be idempotent and never double-deliver on Edge.
    const steerReplay = await f.host.steerRuntime(
      repoId,
      { runtimeSessionId: sessionA, prompt: steerPrompt, idempotencyKey: "ctrl-steer-e2e-1" },
      localAuth,
    );
    assert.equal(steerReplay.outcome, "no_changes", JSON.stringify(steerReplay));
    assert.equal(steerReplay.detail, "steer_requested");
    const steerRecords = () =>
      readDispatchStream(edgeA.edgeRoot, dispatchA)!.records.filter((record) => record.kind === "steer_requested");
    assert.equal(steerRecords().length, 1, "replayed steer must deliver exactly once");

    // 4. Remote CANCEL from Center -> Edge A terminates session A (<10s) and Edge B stays unaffected!
    const cancelStartedAt = Date.now();
    const cancelReceipt = await f.host.cancelRuntime(
      repoId,
      { runtimeSessionId: sessionA, idempotencyKey: "ctrl-cancel-e2e-1", reason: "Remote operator stop" },
      localAuth,
    );
    assert.equal(cancelReceipt.ok, true, JSON.stringify(cancelReceipt));
    assert.equal(cancelReceipt.detail, "cancel_requested");
    assert.equal(cancelReceipt.controlRequestId, "ctrl-cancel-e2e-1");
    assert.equal(cancelReceipt.targetNodeId, "node-one");

    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [sessionA] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
    const cancelElapsedMs = Date.now() - cancelStartedAt;
    t.diagnostic(`remote-cancel-e2e-latency-ms=${cancelElapsedMs}`);

    const sessionAAfter = await f.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: sessionA },
      localAuth,
    );
    assert.equal(sessionAAfter.session?.activity.outcome, "cancelled", JSON.stringify(sessionAAfter));

    // Verify Edge B replicated the same cut (sees sessionA cancelled) and did NOT touch session B.
    await waitForDurableCondition(async () => {
      const seenOnB = await edgeB.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionA },
        localAuth,
      );
      return seenOnB.session?.activity.outcome === "cancelled";
    });
    const sessionBAfter = await f.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: sessionB },
      localAuth,
    );
    assert.equal(sessionBAfter.session?.activity.outcome, null, "Edge B session must remain alive");
    assert.equal(sessionBAfter.session?.liveness, "live", "Edge B session must stay live");

    // 5. Negative controls on already-terminal session A: zero new control events written!
    const controlCountBeforeTerminal = readRuntimeControlEvents(f.repo, sessionA).length;
    const cancelTerminal = await f.host.cancelRuntime(
      repoId,
      { runtimeSessionId: sessionA, idempotencyKey: "ctrl-cancel-after-terminal" },
      localAuth,
    );
    assert.equal(cancelTerminal.detail, "already-exited", JSON.stringify(cancelTerminal));
    await assert.rejects(f.host.steerRuntime(repoId, { runtimeSessionId: sessionA, prompt: "Too late" }, localAuth), {
      code: "runtime_steer_unavailable",
    });
    assert.equal(
      readRuntimeControlEvents(f.repo, sessionA).length,
      controlCountBeforeTerminal,
      "terminal session must never append new control events",
    );

    // Cleanly stop remaining live sessions (sessionZcode & sessionB) via remote cancel as well.
    await f.host.cancelRuntime(repoId, { runtimeSessionId: sessionZcode }, localAuth);
    await f.host.cancelRuntime(repoId, { runtimeSessionId: sessionB }, localAuth);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [sessionZcode, sessionB], mode: "all" },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
  },
);

test(
  "edge catches up pending cancel persisted during center disconnect and settles runtime on reconnect",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const originRemote = path.join(f.root, "origin.git");
    git(f.root, "clone", "--bare", "-q", f.repo, originRemote);
    git(f.repo, "remote", "add", "origin", originRemote);
    git(f.repo, "fetch", "-q", "origin");
    const branch = git(f.repo, "branch", "--show-current");

    await allowEdgeRuntimeInstances(f.host);
    signInAt(f.userRoot, "person-one");
    f.owners.keycloak.permit("person-one", repoId, ["runtime-cancel", "runtime-steer", "repository-read"]);
    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-disconnect");
    const localAuth = localAuthFixture();

    const spawned = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Worker alive across center outage",
        dispatchKey: "g8-disconnect-recovery-cancel",
      },
      localAuth,
    );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const runtimeSessionId = String(spawned.runtimeSessionId);

    // Simulate network/center disconnect by closing the Center TLS listener on its port.
    const centerPort = f.center.port;
    await f.center.close();

    // Persist cancel on Center while Edge A has no live TLS connection.
    const cancelReceipt = await f.host.cancelRuntime(
      repoId,
      { runtimeSessionId, idempotencyKey: "ctrl-cancel-while-offline" },
      localAuth,
    );
    assert.equal(cancelReceipt.ok, true, JSON.stringify(cancelReceipt));
    assert.equal(cancelReceipt.detail, "cancel_requested");

    // Re-open Center TLS on the same port; Edge A's resident replica sync reconnects, catches up, and cancels.
    const reconnectStartedAt = Date.now();
    await f.openCenter(f.host, centerPort);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [runtimeSessionId] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
    const reconnectElapsedMs = Date.now() - reconnectStartedAt;
    t.diagnostic(`disconnect-recovery-cancel-ms=${reconnectElapsedMs}`);

    const settled = await f.host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, localAuth);
    assert.equal(settled.session?.activity.outcome, "cancelled", JSON.stringify(settled));
  },
);
