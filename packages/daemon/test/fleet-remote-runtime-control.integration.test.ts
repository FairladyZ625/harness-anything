// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  hydrateReplicaSeed,
  makeTaskEventReader,
  openReplicaProjection,
  openSqliteEventStore,
} from "@harness-anything/storage";
import {
  reduceRuntimeSession,
  validateAgentRuntimeEvent,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instances.ts";
import { runFleetTaskCommandClient } from "../src/daemon-host/fleet/peer.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetHostWriterOptions } from "./fleet-store.fixture.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";

const repoId = "lease-repo";
const secondRepoId = "second-repo";

// Exact frozen agentRuntimeEventTypes allowlist from N-1 baseline (bb7e55c90d7bd8f15ffba849e0326c153716c8d9).
const N_MINUS_1_AGENT_RUNTIME_EVENT_TYPES = new Set([
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_squad_run_observed",
  "runtime_session_started",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_session_liveness_changed",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
  "runtime_dispatch_outcome_unknown",
  "runtime_handoff_exported",
  "runtime_handoff_revoked",
]);

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createObservableCodexProviderScript(dir: string, name: string, tracePath: string, threadId: string): string {
  const scriptPath = path.join(dir, `${name}.mjs`);
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'if (process.argv.includes("login") || process.argv.includes("doctor") || process.argv.includes("--version")) {',
      '  process.stdout.write("Logged in\\n");',
      "  process.exit(0);",
      "}",
      'if (process.argv.includes("--skip-git-repo-check")) {',
      '  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
      "  process.exit(0);",
      "}",
      `const tracePath = ${JSON.stringify(tracePath)};`,
      `const threadId = ${JSON.stringify(threadId)};`,
      'let prompt = "";',
      "for await (const chunk of process.stdin) prompt += chunk;",
      'const isResume = process.argv.includes("resume");',
      'fs.appendFileSync(tracePath, JSON.stringify({ isResume, args: process.argv.slice(2), prompt }) + "\\n");',
      'const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      'emit({ type: "thread.started", thread_id: threadId });',
      'if (prompt.includes("[HOLD_TOOL]")) {',
      '  emit({ type: "item.started", item: { id: "tool-hold", type: "command_execution" } });',
      "}",
      'process.on("SIGINT", () => process.exit(0));',
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => undefined, 1000);",
    ].join("\n") + "\n",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function readProviderTrace(tracePath: string): Array<{
  readonly isResume: boolean;
  readonly args: readonly string[];
  readonly prompt: string;
}> {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { isResume: boolean; args: string[]; prompt: string });
}

async function setupEdgeNode(
  t: TestContext,
  f: Awaited<ReturnType<typeof fleetNodeClaimFixture>>,
  originRemote: string,
  branch: string,
  nodeId: string,
  name: string,
  codexExecutablePath: string,
) {
  const codexInstallation: RuntimeInstallationWitness = {
    installationId: `${nodeId}-codex-install`,
    kindId: "codex",
    executablePath: codexExecutablePath,
    version: "1.0.0",
    observedAt: "2026-11-21T00:00:00.000Z",
  };
  const zcodeInstallation: RuntimeInstallationWitness = {
    installationId: `${nodeId}-zcode-install`,
    kindId: "zcode",
    executablePath: codexExecutablePath,
    version: "1.0.0",
    observedAt: "2026-11-21T00:00:00.000Z",
  };
  const edge = await fleetEdgeHostFixture(t, f, {
    name,
    nodeId,
    personId: "person-one",
    runtimeDiscover: () => [codexInstallation, zcodeInstallation],
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
  return { edge };
}

function readRuntimeControlEvents(repoRoot: string, targetRepoId: string, runtimeSessionId?: string) {
  return makeTaskEventReader({ repoId: targetRepoId, rootDir: repoRoot })
    .read()
    .events.filter(
      (event): event is AgentRuntimeEventV1 =>
        event.schema === "agent-runtime-event/v1" &&
        (event.type === "runtime_cancel_requested" ||
          event.type === "runtime_steer_requested" ||
          (event.type === "runtime_session_liveness_changed" && event.payload.controlRequest !== undefined)) &&
        (runtimeSessionId === undefined || event.payload.runtimeSessionId === runtimeSessionId),
    );
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
  "center & cross-edge CLI cancel/steer observable edge providers over TLS WAL with correlated receipts, two-repo auth isolation, and N/N-1 seed compat",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const originRemote = path.join(f.root, "origin.git");
    git(f.root, "clone", "--bare", "-q", f.repo, originRemote);
    git(f.repo, "remote", "add", "origin", originRemote);
    git(f.repo, "fetch", "-q", "origin");
    const branch = git(f.repo, "branch", "--show-current");

    // F7: Provision a SECOND real attached repository (`second-repo`) on Center!
    const secondRepo = path.join(f.root, "second-repo");
    mkdirSync(path.join(secondRepo, "harness"), { recursive: true });
    git(secondRepo, "init", "-q");
    git(secondRepo, "config", "user.name", "Second Repo Test");
    git(secondRepo, "config", "user.email", "second@example.invalid");
    git(secondRepo, "commit", "--allow-empty", "-qm", "base");
    writeFileSync(
      path.join(secondRepo, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: second\nsettings: {}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    git(secondRepo, "add", "harness");
    git(secondRepo, "commit", "-qm", "harness");
    f.owners.keycloak.permit("lease-owner", secondRepoId, ["daemon-repo-register", "repository-read"]);
    const attachedSecond = await f.host.admin(
      { kind: "register", rootDir: secondRepo, repoId: secondRepoId, mode: "local" },
      localAuthFixture(),
    );
    assert.equal(attachedSecond.ok, true, JSON.stringify(attachedSecond));
    // Re-open Center TLS serving BOTH `lease-repo` and `second-repo`!
    const centerPort = f.center.port;
    await f.center.close();
    const multiRepoCenter = await f.openCenter(f.host, centerPort, {
      ...fleetHostWriterOptions(f.userRoot, [repoId, secondRepoId]),
    } as never);
    void multiRepoCenter;

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

    // F7: Principal authorized ONLY on `second-repo` (NOT on `lease-repo`).
    f.owners.keycloak.account("person-second-repo-only");
    f.owners.keycloak.permit("person-second-repo-only", secondRepoId, [
      "runtime-cancel",
      "runtime-steer",
      "repository-read",
    ]);
    f.owners.keycloak.interactiveSession(
      "person-second-repo-only",
      "center-node",
      f.owners.url,
      "bff-second-repo-token",
      "web-bff",
    );

    const tracePathA = path.join(f.root, "provider-trace-a.jsonl"),
      tracePathB = path.join(f.root, "provider-trace-b.jsonl"),
      providerA = createObservableCodexProviderScript(f.root, "provider-a", tracePathA, "thread-edge-a-real-1"),
      providerB = createObservableCodexProviderScript(f.root, "provider-b", tracePathB, "thread-edge-b-real-1");

    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-a", providerA);
    const { edge: edgeB } = await setupEdgeNode(t, f, originRemote, branch, "node-two", "edge-b", providerB);
    const localAuth = localAuthFixture();

    // 1. Spawn real native observable provider sessions on Edge A (codex, hold-tool codex, zcode) and Edge B (codex).
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

    const spawnHold = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "[HOLD_TOOL] Worker holding active tool for steer_dropped receipt test",
        dispatchKey: "g8-remote-control-edge-a-hold",
      },
      localAuth,
    );
    assert.equal(spawnHold.outcome, "applied", JSON.stringify(spawnHold));
    const sessionHold = String(spawnHold.runtimeSessionId);

    const spawnZcode = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-zcode",
        cwd: { scope: "repo-root" },
        prompt: "Non-steerable runtime on Edge A",
        dispatchKey: "g8-remote-control-edge-a-zcode",
        permissionMode: "bypass",
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

    await waitForProviderBound(f.host, sessionA, localAuth);
    await waitForProviderBound(f.host, sessionHold, localAuth);
    await waitForProviderBound(f.host, sessionB, localAuth);

    // 2. Negative controls BEFORE any valid control event is written:
    // 2a. Unauthorized principal via Web BFF TLS frame -> authorization_denied.
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

    // 2b. Non-owner principal -> execution_scope_mismatch.
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

    // 2c. F7 True two-repo cross-repo authorization negative test:
    // Prove `person-second-repo-only` is valid on `second-repo`, then assert EXACT `authorization_denied` on `lease-repo`!
    const validSecondRepoRead = await f.host.read(
      secondRepoId,
      "repo.agentRuntime.overview",
      {},
      {
        transportKind: "fleet-tls",
        nodePrincipal: { nodeId: "center-node", personId: "person-second-repo-only" },
        humanAccessToken: "bff-second-repo-token",
      },
    );
    assert.equal(validSecondRepoRead.ok, true, JSON.stringify(validSecondRepoRead));
    for (const action of [
      { kind: "runtime-cancel", runtimeSessionId: sessionA },
      { kind: "runtime-steer", runtimeSessionId: sessionA, prompt: "Cross-repo steer denied" },
    ]) {
      await assert.rejects(
        runFleetTaskCommandClient({
          port: f.center.port,
          ca: readFileSync(path.join(f.root, "tls.crt")),
          servername: "localhost",
          nodeId: "center-node",
          credential: "secret-center-node",
          readAccessToken: async () => "bff-second-repo-token",
          accessToken: "bff-second-repo-token",
          opId: randomUUID(),
          repoId,
          taskId: null,
          waitMs: 5_000,
          action: action as never,
        }),
        { code: "authorization_denied" },
      );
    }

    // 2d. Unsupported steer provider (zcode) -> runtime_steer_unsupported at Center entry.
    await assert.rejects(
      f.host.steerRuntime(repoId, { runtimeSessionId: sessionZcode, prompt: "Cannot steer zcode" }, localAuth),
      { code: "runtime_steer_unsupported" },
    );
    assert.equal(
      readRuntimeControlEvents(f.repo, repoId).length,
      0,
      "rejected requests must write zero control events",
    );
    assert.equal(readRuntimeControlEvents(secondRepo, secondRepoId).length, 0);

    // 3. F3 + F5: Remote STEER via Web BFF omitting idempotencyKey (frame.opId bound as idempotency key)
    //    -> real observable test provider receives steered prompt on stdin -> correlated Edge->Center controlReceipt!
    const steerPrompt1 = "Shift focus to remote control verification.";
    const stableFrameOpId = `bff-frame-op-${randomUUID()}`;
    const steerViaBff = await runFleetTaskCommandClient({
      port: f.center.port,
      ca: readFileSync(path.join(f.root, "tls.crt")),
      servername: "localhost",
      nodeId: "center-node",
      credential: "secret-center-node",
      readAccessToken: async () => "bff-owner-token",
      accessToken: "bff-owner-token",
      opId: stableFrameOpId,
      repoId,
      taskId: null,
      waitMs: 5_000,
      action: {
        kind: "runtime-steer",
        runtimeSessionId: sessionA,
        prompt: steerPrompt1,
      } as never,
    });
    assert.equal(steerViaBff.outcome, "applied", JSON.stringify(steerViaBff));
    assert.equal(steerViaBff.receipt?.detail, "steer_requested");
    assert.equal(steerViaBff.receipt?.controlRequestId, stableFrameOpId, "frame.opId must bind as controlRequestId");
    assert.equal(steerViaBff.receipt?.targetNodeId, "node-one");

    // Verify the REAL observable provider process received steerPrompt1 via `exec resume`!
    await waitForDurableCondition(async () =>
      readProviderTrace(tracePathA).some((entry) => entry.isResume && entry.prompt === steerPrompt1),
    );
    // Verify Edge->Center correlated `controlReceipt(status="applied")` landed on Center and is readable via sessions.read!
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionA },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) => rcpt.controlRequestId === stableFrameOpId && rcpt.status === "applied" && rcpt.steerVersion === 1,
        ),
      );
    });

    // F3: Retrying the EXACT SAME Fleet frame (same frame.opId, still omitting idempotencyKey) must be idempotent!
    const steerFrameRetry = await runFleetTaskCommandClient({
      port: f.center.port,
      ca: readFileSync(path.join(f.root, "tls.crt")),
      servername: "localhost",
      nodeId: "center-node",
      credential: "secret-center-node",
      readAccessToken: async () => "bff-owner-token",
      accessToken: "bff-owner-token",
      opId: stableFrameOpId,
      repoId,
      taskId: null,
      waitMs: 5_000,
      action: {
        kind: "runtime-steer",
        runtimeSessionId: sessionA,
        prompt: steerPrompt1,
      } as never,
    });
    assert.equal(steerFrameRetry.receipt?.outcome, "no_changes", JSON.stringify(steerFrameRetry));
    assert.equal(steerFrameRetry.receipt?.controlRequestId, stableFrameOpId);
    assert.equal(
      readProviderTrace(tracePathA).filter((entry) => entry.prompt === steerPrompt1).length,
      1,
      "retried frame.opId must deliver steered prompt exactly once to provider",
    );

    // 4. F5: Edge `runtime_steer_target_changed` rejection receipt end-to-end!
    const mismatchSteer = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: sessionA,
        prompt: "Mismatched version steer",
        expected: { dispatchId: dispatchA, version: 99 },
        idempotencyKey: "ctrl-steer-version-mismatch",
      },
      localAuth,
    );
    assert.equal(mismatchSteer.outcome, "applied", JSON.stringify(mismatchSteer));
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionA },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.controlRequestId === "ctrl-steer-version-mismatch" &&
            rcpt.status === "rejected" &&
            rcpt.reasonCode === "runtime_steer_target_changed",
        ),
      );
    });

    // 5. F5: Real worker `steer_dropped` rejection receipt end-to-end!
    // On `sessionHold` (active tool running), send two steers back-to-back so worker drops the superseded first steer.
    const dropSteer1 = await f.host.steerRuntime(
      repoId,
      { runtimeSessionId: sessionHold, prompt: "Superseded steer 1", idempotencyKey: "ctrl-steer-drop-1" },
      localAuth,
    );
    assert.equal(dropSteer1.outcome, "applied", JSON.stringify(dropSteer1));
    const dropSteer2 = await f.host.steerRuntime(
      repoId,
      { runtimeSessionId: sessionHold, prompt: "Superseding steer 2", idempotencyKey: "ctrl-steer-drop-2" },
      localAuth,
    );
    assert.equal(dropSteer2.outcome, "applied", JSON.stringify(dropSteer2));
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionHold },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.controlRequestId === "ctrl-steer-drop-1" &&
            rcpt.status === "rejected" &&
            rcpt.reasonCode === "steer_dropped",
        ),
      );
    });

    // 6. F6: Cross-Edge CLI/RPC routing — CLI call on Edge B steers AND cancels sessionA running on Edge A!
    const crossEdgeSteerPrompt = "Steer from Edge B CLI targeting Edge A";
    const edgeBSteer = await edgeB.command({
      kind: "runtime-steer",
      runtimeSessionId: sessionA,
      prompt: crossEdgeSteerPrompt,
      idempotencyKey: "ctrl-cross-edge-steer-1",
    });
    assert.equal(edgeBSteer.ok, true, JSON.stringify(edgeBSteer));
    assert.equal(edgeBSteer.detail, "steer_requested");
    assert.equal(edgeBSteer.targetNodeId, "node-one");
    await waitForDurableCondition(async () =>
      readProviderTrace(tracePathA).some((entry) => entry.isResume && entry.prompt === crossEdgeSteerPrompt),
    );
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionA },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.controlRequestId === "ctrl-cross-edge-steer-1" && rcpt.status === "applied" && rcpt.steerVersion === 2,
        ),
      );
    });

    const cancelStartedAt = Date.now();
    const edgeBCancelA = await edgeB.command({
      kind: "runtime-cancel",
      runtimeSessionId: sessionA,
      idempotencyKey: "ctrl-cross-edge-cancel-1",
      reason: "Cross-edge operator stop from Edge B",
    });
    assert.equal(edgeBCancelA.ok, true, JSON.stringify(edgeBCancelA));
    assert.equal(edgeBCancelA.detail, "cancel_requested");
    assert.equal(edgeBCancelA.controlRequestId, "ctrl-cross-edge-cancel-1");
    assert.equal(edgeBCancelA.targetNodeId, "node-one");

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

    // Verify Edge B replicated the same cut and did NOT touch its own sessionB.
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

    // 7. Negative controls on already-terminal session A: zero new control events written!
    const controlCountBeforeTerminal = readRuntimeControlEvents(f.repo, repoId, sessionA).length;
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
      readRuntimeControlEvents(f.repo, repoId, sessionA).length,
      controlCountBeforeTerminal,
      "terminal session must never append new control events",
    );

    // 8. F6 local synchronous path: Edge B cancels its OWN local sessionB directly (not via cancel_requested)!
    const localCancelB = await edgeB.command({ kind: "runtime-cancel", runtimeSessionId: sessionB });
    assert.equal(localCancelB.ok, true, JSON.stringify(localCancelB));
    assert.notEqual(localCancelB.detail, "cancel_requested", "local edge cancel must stay synchronous");

    // Stop remaining live sessions on Edge A cleanly.
    await f.host.cancelRuntime(repoId, { runtimeSessionId: sessionHold }, localAuth);
    await f.host.cancelRuntime(repoId, { runtimeSessionId: sessionZcode }, localAuth);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [sessionHold, sessionZcode, sessionB], mode: "all" },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );

    // 9. F8 Rolling-upgrade N / N-1 compatibility proof:
    //    (a) Every emitted canonical runtime event stays inside bb7e55c90's frozen 13-type allowlist,
    //    (b) Real `hydrateReplicaSeed` hydrates a PG-style `canonical-seed.json` containing both cancel & steer
    //        control events + control receipts cleanly into a fresh Edge replica,
    //    (c) N-1 `validateAgentRuntimeEvent` + `reduceRuntimeSession` accept every single control event, and
    //    (d) A fresh Edge hydrated from that seed continues ordinary WAL replication cleanly!
    const ledger = openSqliteEventStore({ rootInput: f.repo, repoId, readOnly: true });
    const seedRoot = mkdtempSync(path.join(tmpdir(), "ha-g8-seed-compat-"));
    t.after(() => rmSync(seedRoot, { recursive: true, force: true }));
    try {
      const position = ledger.replicationPosition();
      const allEvents = ledger.events();
      const runtimeEvents = allEvents.filter(
        (event): event is AgentRuntimeEventV1 => event.schema === "agent-runtime-event/v1",
      );
      const emittedControls = runtimeEvents.filter(
        (event) => event.type === "runtime_session_liveness_changed" && event.payload.controlRequest !== undefined,
      );
      const emittedReceipts = runtimeEvents.filter(
        (event) => event.type === "runtime_session_liveness_changed" && event.payload.controlReceipt !== undefined,
      );
      assert.ok(
        emittedControls.some((e) => e.payload.controlRequest?.action === "cancel"),
        "ledger must contain emitted cancel controlRequest",
      );
      assert.ok(
        emittedControls.some((e) => e.payload.controlRequest?.action === "steer"),
        "ledger must contain emitted steer controlRequest",
      );
      assert.ok(emittedReceipts.length >= 3, "ledger must contain applied and rejected controlReceipts");
      for (const event of runtimeEvents) {
        assert.ok(
          N_MINUS_1_AGENT_RUNTIME_EVENT_TYPES.has(event.type),
          `event type ${event.type} must stay within N-1 allowlist during compatibility window`,
        );
        assert.deepEqual(validateAgentRuntimeEvent(event), []);
      }
      // Verify N-1 session reduction over the entire sessionA event stream succeeds with zero errors.
      let reduced: RuntimeSession | null = null;
      for (const event of runtimeEvents.filter(
        (e) => "runtimeSessionId" in e.payload && e.payload.runtimeSessionId === sessionA,
      )) {
        reduced = reduceRuntimeSession(reduced, event);
      }
      assert.equal(reduced?.outcome, "cancelled");

      // Build exact PG-style canonical-seed.json from real ledger rows/outcomes and run real `hydrateReplicaSeed`!
      const rawEvents = ledger.eventRows();
      const outcomes = ledger.outcomes();
      const genDir = path.join(seedRoot, ".harness", "store", "generations", "3");
      mkdirSync(genDir, { recursive: true });
      const { canonicalEventContentClaims } = await import(
        "@harness-anything/kernel/internal/ports/canonical-event-store.ts"
      );
      for (const event of allEvents) {
        for (const claim of canonicalEventContentClaims(event as never)) {
          const blob = ledger.readContentObject(claim.sha256);
          if (blob) {
            const objDir = path.join(genDir, "objects", "sha256", claim.sha256.slice(0, 2));
            mkdirSync(objDir, { recursive: true });
            writeFileSync(path.join(objDir, claim.sha256.slice(2)), blob);
          }
        }
      }
      writeFileSync(
        path.join(genDir, "canonical-seed.json"),
        JSON.stringify({
          events: rawEvents,
          outcomes,
          writer: { repoId, holder: "center-seed-writer", epoch: 1 },
        }),
      );
      await hydrateReplicaSeed(seedRoot, {
        schema: "fleet-basebackup/v3",
        repoId,
        readerProfile: null,
        position,
        ledgerGeneration: 3,
        projectionSchema: 1,
      });
      const hydrated = openReplicaProjection({
        repoId,
        rootDir: seedRoot,
        ledgerPath: path.join(genDir, "ledger.sqlite"),
        projectionPath: path.join(seedRoot, ".harness", "cache", "task.sqlite"),
        generation: 3,
      });
      try {
        assert.equal(hydrated.projection.readRuntimeSession(sessionA)?.outcome, "cancelled");
      } finally {
        hydrated.close();
      }
    } finally {
      ledger.close();
    }

    // Boot a fresh Edge C after cancel & steer control events exist in Center and confirm it catches up cleanly!
    await edgeA.host.close();
    const freshViewRoot = mkdtempSync(path.join(tmpdir(), "ha-g8-edge-c-view-"));
    t.after(() => rmSync(freshViewRoot, { recursive: true, force: true }));
    await catchUpReplica({
      ...f.peer("node-one"),
      ca: readFileSync(path.join(f.root, "tls.crt")),
      viewRoot: freshViewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
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
    const tracePath = path.join(f.root, "provider-trace-disconnect.jsonl"),
      provider = createObservableCodexProviderScript(f.root, "provider-disconnect", tracePath, "thread-disconnect-1");
    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-disconnect", provider);
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
    await waitForProviderBound(f.host, runtimeSessionId, localAuth);

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
