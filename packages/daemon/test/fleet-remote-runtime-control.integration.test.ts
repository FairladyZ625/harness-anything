// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { runFleetTaskCommandClient } from "../src/daemon-host/fleet/peer.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { readRuntimeExecutionPrincipal } from "../src/daemon-host/runtime-execution-principal-store.ts";
import { requireExecutionRequestScope } from "../src/daemon-host/runtime-execution-scope.ts";
import { createUnixSocketTransportServer } from "../src/daemon-host/transport/unix-socket.ts";
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

// Exact frozen closed field sets for N-1 validSession (bb7e55c90d:packages/daemon/src/daemon-host/agent-runtime-contract.ts:609-642).
// Notably omits "controlReceipts" so any additive field leak on default detail/overview fails immediately.
const N_MINUS_1_SESSION_REQUIRED_FIELDS = [
  "runtimeSessionId",
  "providerSessionId",
  "instanceId",
  "installationId",
  "kindId",
  "definitionSnapshotRef",
  "definitionSnapshot",
  "definitionSnapshotPersisted",
  "liveness",
  "attachCapability",
  "streamCursor",
  "associations",
  "activity",
] as const;
const N_MINUS_1_SESSION_OPTIONAL_FIELDS = [
  "installationState",
  "installationError",
  "semanticState",
  "attemptChain",
  "metrics",
  "context",
  "lifecycle",
  "nodeId",
  "effectivePermissionMode",
  "requestedPermissionMode",
  "permissionModeSource",
] as const;
function assertNMinus1ValidSession(session: unknown, label: string): void {
  assert.ok(session !== null && typeof session === "object" && !Array.isArray(session), `${label} must be an object`);
  const record = session as Record<string, unknown>;
  for (const field of N_MINUS_1_SESSION_REQUIRED_FIELDS)
    assert.ok(Object.hasOwn(record, field), `${label} missing N-1 required field ${field}`);
  const allowed = new Set<string>([...N_MINUS_1_SESSION_REQUIRED_FIELDS, ...N_MINUS_1_SESSION_OPTIONAL_FIELDS]);
  for (const key of Object.keys(record))
    assert.ok(allowed.has(key), `${label} leaked unknown N-1 session field "${key}" (breaks N-1 closed validSession)`);
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createObservableCodexProviderScript(
  dir: string,
  name: string,
  tracePath: string,
  threadId: string,
  options?: {
    readonly credentialDumpPath?: string;
    readonly resumeStartedFile?: string;
    readonly resumeGateFile?: string;
  },
): string {
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
      `const credentialDumpPath = ${JSON.stringify(options?.credentialDumpPath ?? null)};`,
      `const resumeStartedFile = ${JSON.stringify(options?.resumeStartedFile ?? null)};`,
      `const resumeGateFile = ${JSON.stringify(options?.resumeGateFile ?? null)};`,
      "if (credentialDumpPath && process.env.HARNESS_EXECUTION_CREDENTIAL) {",
      "  fs.writeFileSync(credentialDumpPath, process.env.HARNESS_EXECUTION_CREDENTIAL);",
      "}",
      'let prompt = "";',
      "for await (const chunk of process.stdin) prompt += chunk;",
      'const isResume = process.argv.includes("resume");',
      'fs.appendFileSync(tracePath, JSON.stringify({ isResume, args: process.argv.slice(2), prompt }) + "\\n");',
      'if (isResume && prompt.includes("[REJECT_STEER]")) {',
      '  process.stderr.write("provider rejected steered prompt\\n");',
      "  process.exit(1);",
      "}",
      "if (isResume && resumeStartedFile) {",
      '  fs.writeFileSync(resumeStartedFile, "resumed");',
      "}",
      "if (isResume && resumeGateFile) {",
      "  while (!fs.existsSync(resumeGateFile)) await new Promise((resolve) => setTimeout(resolve, 25));",
      "}",
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
      sessionBCredentialPath = path.join(f.root, "session-b-credential.txt"),
      providerA = createObservableCodexProviderScript(f.root, "provider-a", tracePathA, "thread-edge-a-real-1"),
      providerB = createObservableCodexProviderScript(f.root, "provider-b", tracePathB, "thread-edge-b-real-1", {
        credentialDumpPath: sessionBCredentialPath,
      });

    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-a", providerA);
    const { edge: edgeB } = await setupEdgeNode(t, f, originRemote, branch, "node-two", "edge-b", providerB);
    const localAuth = localAuthFixture();
    // F6: Start a real Unix-socket JSON-RPC server for Edge B so the real CLI entrypoint talks to Edge B.
    const edgeBDaemonId = "edge-b-cli-daemon";
    const edgeBTransport = createUnixSocketTransportServer({
      daemonId: edgeBDaemonId,
      socketPath: localUserDaemonEndpoint(edgeB.edgeUser, edgeBDaemonId),
      createProtocolServer: (authContext, emit, _connectionId, connectionSignal) =>
        createJsonRpcProtocolServer({
          host: edgeB.host,
          build: daemonBuildStamp(),
          authContext: { ...authContext, connectionSignal },
          sessionPrincipal: (method, params) =>
            edgeB.host.sessionPrincipal({ ...authContext, connectionSignal }, method, params),
          executionPrincipal: async (credential, method, params) => {
            const principal = readRuntimeExecutionPrincipal(edgeB.edgeRoot, credential);
            if (!principal)
              throw Object.assign(new Error("Execution credential is unknown or expired on this edge runtime."), {
                code: "authorization_denied",
              });
            requireExecutionRequestScope(principal, method, params);
            return principal;
          },
          emit,
        }),
    });
    await edgeBTransport.start();
    t.after(() => edgeBTransport.stop());
    const invokeEdgeBCli = async (args: readonly string[], extraEnv?: Record<string, string>) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", edgeB.edgeRoot, "--json", ...args],
        {
          env: {
            ...env,
            HARNESS_DAEMON_USER_ROOT: edgeB.edgeUser,
            HARNESS_DAEMON_ID: edgeBDaemonId,
            ...(extraEnv ?? {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
      return { code, stdout, stderr, receipt: JSON.parse(stdout) as Record<string, unknown> };
    };

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

    // 3. F3 + F5: Remote compare-and-steer via Web BFF omitting idempotencyKey (frame.opId bound as idempotency key)
    //    with expected.version=0 -> real observable test provider receives steered prompt -> correlated controlReceipt (version=1)!
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
        expected: { dispatchId: dispatchA, version: 0 },
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
    // Verify Edge->Center correlated `controlReceipt(status="applied")` landed on Center and is readable via opt-in includeControlReceipts!
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionA, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) => rcpt.controlRequestId === stableFrameOpId && rcpt.status === "applied" && rcpt.steerVersion === 1,
        ),
      );
    });

    // F10: Verify N-1 client read compatibility (dec_659E15CF/CH1) AFTER controlReceipts exist on Center!
    // Default session detail & overview MUST NOT include `controlReceipts` and MUST pass the frozen N-1 validSession decoder.
    const defaultSessionDetail = await f.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: sessionA },
      localAuth,
    );
    assert.equal(defaultSessionDetail.session?.controlReceipts, undefined);
    assertNMinus1ValidSession(defaultSessionDetail.session, "default sessions.read");
    const defaultOverview = await f.host.read(repoId, "repo.agentRuntime.overview", {}, localAuth);
    assert.ok((defaultOverview.sessions?.length ?? 0) >= 1);
    for (const overviewSession of defaultOverview.sessions ?? []) {
      assert.equal(overviewSession.controlReceipts, undefined);
      assertNMinus1ValidSession(overviewSession, `overview.sessions[${overviewSession.runtimeSessionId}]`);
    }

    // F3: Retrying the EXACT SAME Fleet compare-and-steer frame AFTER version advanced 0->1 (simulating lost response)
    //     MUST recover the recorded no_changes receipt instead of failing with runtime_steer_target_changed!
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
        expected: { dispatchId: dispatchA, version: 0 },
      } as never,
    });
    assert.equal(steerFrameRetry.receipt?.outcome, "no_changes", JSON.stringify(steerFrameRetry));
    assert.equal(steerFrameRetry.receipt?.controlRequestId, stableFrameOpId);
    assert.equal(
      readProviderTrace(tracePathA).filter((entry) => entry.prompt === steerPrompt1).length,
      1,
      "retried frame.opId must deliver steered prompt exactly once to provider",
    );
    // Meanwhile, a NEW request with stale expected.version=0 MUST still be rejected with runtime_steer_target_changed!
    await assert.rejects(
      runFleetTaskCommandClient({
        port: f.center.port,
        ca: readFileSync(path.join(f.root, "tls.crt")),
        servername: "localhost",
        nodeId: "center-node",
        credential: "secret-center-node",
        readAccessToken: async () => "bff-owner-token",
        accessToken: "bff-owner-token",
        opId: `bff-frame-stale-${randomUUID()}`,
        repoId,
        taskId: null,
        waitMs: 5_000,
        action: {
          kind: "runtime-steer",
          runtimeSessionId: sessionA,
          prompt: "Stale version new request",
          expected: { dispatchId: dispatchA, version: 0 },
        } as never,
      }),
      { code: "runtime_steer_target_changed" },
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
        { runtimeSessionId: sessionA, includeControlReceipts: true },
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
        { runtimeSessionId: sessionHold, includeControlReceipts: true },
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

    // 5b. F9: Preserve executionPrincipal across cross-Edge forwarding!
    // A taskless session credential spawned on Edge B must NEVER be silently upgraded to the device operator when
    // targeting Edge A: Center must reject both cross-Edge steer and cancel with execution_scope_mismatch.
    await waitForDurableCondition(async () => existsSync(sessionBCredentialPath));
    const sessionBCredential = readFileSync(sessionBCredentialPath, "utf8").trim();
    assert.ok(sessionBCredential.length > 0, "Edge B spawned session must receive a real execution credential");
    const controlCountBeforeExecCred = readRuntimeControlEvents(f.repo, repoId, sessionA).length;
    const deniedExecSteer = await edgeB.command(
      {
        kind: "runtime-steer",
        runtimeSessionId: sessionA,
        prompt: "Session credential must not steer remote Edge A",
      },
      sessionBCredential,
    );
    assert.equal(deniedExecSteer.ok, false, JSON.stringify(deniedExecSteer));
    assert.equal(
      (deniedExecSteer.error as { readonly code?: string } | undefined)?.code,
      "execution_scope_mismatch",
      JSON.stringify(deniedExecSteer),
    );
    const deniedExecCancel = await edgeB.command(
      {
        kind: "runtime-cancel",
        runtimeSessionId: sessionA,
      },
      sessionBCredential,
    );
    assert.equal(deniedExecCancel.ok, false, JSON.stringify(deniedExecCancel));
    assert.equal(
      (deniedExecCancel.error as { readonly code?: string } | undefined)?.code,
      "execution_scope_mismatch",
      JSON.stringify(deniedExecCancel),
    );
    assert.equal(
      readRuntimeControlEvents(f.repo, repoId, sessionA).length,
      controlCountBeforeExecCred,
      "rejected executionPrincipal cross-edge control must write zero events",
    );

    // 6. F6: Real CLI entrypoint on Edge B routed through shared Edge write boundary (retry + replicationSequence wait)!
    // IMMEDIATELY upon CLI return (zero polling), Edge B's own local replica must ALREADY observe the written cut!
    const crossEdgeSteerPrompt = "Steer from Edge B real CLI targeting Edge A";
    const cliSteerA = await invokeEdgeBCli(["runtime", "steer", sessionA, "--prompt", crossEdgeSteerPrompt]);
    assert.equal(cliSteerA.code, 0, JSON.stringify(cliSteerA));
    assert.equal(cliSteerA.receipt.ok, true, JSON.stringify(cliSteerA.receipt));
    assert.equal(cliSteerA.receipt.detail, "steer_requested");
    assert.equal(cliSteerA.receipt.targetNodeId, "node-one");
    assert.equal(typeof cliSteerA.receipt.revision, "number", JSON.stringify(cliSteerA.receipt));
    const immediateSteerReadOnB = await edgeB.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: sessionA },
      localAuth,
    );
    assert.ok(
      immediateSteerReadOnB.watermark >= Number(cliSteerA.receipt.revision),
      `Edge B replica watermark (${immediateSteerReadOnB.watermark}) must already include CLI steer cut (${cliSteerA.receipt.revision}) immediately upon return`,
    );
    await waitForDurableCondition(async () =>
      readProviderTrace(tracePathA).some((entry) => entry.isResume && entry.prompt === crossEdgeSteerPrompt),
    );
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: sessionA, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.controlRequestId === cliSteerA.receipt.controlRequestId &&
            rcpt.status === "applied" &&
            rcpt.steerVersion === 2,
        ),
      );
    });

    const cancelStartedAt = Date.now();
    const cliCancelA = await invokeEdgeBCli(["runtime", "cancel", sessionA]);
    assert.equal(cliCancelA.code, 0, JSON.stringify(cliCancelA));
    assert.equal(cliCancelA.receipt.ok, true, JSON.stringify(cliCancelA.receipt));
    assert.equal(cliCancelA.receipt.detail, "cancel_requested");
    assert.equal(cliCancelA.receipt.targetNodeId, "node-one");
    assert.equal(typeof cliCancelA.receipt.revision, "number", JSON.stringify(cliCancelA.receipt));
    const immediateCancelReadOnB = await edgeB.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: sessionA },
      localAuth,
    );
    assert.ok(
      immediateCancelReadOnB.watermark >= Number(cliCancelA.receipt.revision),
      `Edge B replica watermark (${immediateCancelReadOnB.watermark}) must already include CLI cancel cut (${cliCancelA.receipt.revision}) immediately upon return`,
    );

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

    // 8. F6 local synchronous path via real CLI: Edge B cancels its OWN local sessionB directly (not via cancel_requested)!
    const cliLocalCancelB = await invokeEdgeBCli(["runtime", "cancel", sessionB]);
    assert.equal(cliLocalCancelB.code, 0, JSON.stringify(cliLocalCancelB));
    assert.equal(cliLocalCancelB.receipt.ok, true, JSON.stringify(cliLocalCancelB.receipt));
    assert.notEqual(cliLocalCancelB.receipt.detail, "cancel_requested", "local edge CLI cancel must stay synchronous");

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

test(
  "F5: provider rejection reports rejected (never applied) and transient disconnect replays pending steer receipt on reconnect",
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
    const tracePath = path.join(f.root, "provider-trace-f5.jsonl"),
      resumeStartedFile = path.join(f.root, "provider-f5-resume-started"),
      resumeGateFile = path.join(f.root, "provider-f5-resume-gate"),
      provider = createObservableCodexProviderScript(f.root, "provider-f5", tracePath, "thread-f5-1", {
        resumeStartedFile,
        resumeGateFile,
      });
    const { edge: edgeA } = await setupEdgeNode(t, f, originRemote, branch, "node-one", "edge-f5", provider);
    const localAuth = localAuthFixture();

    // Part A: Real provider rejects steered resume ([REJECT_STEER] -> exits 1 without emitting thread.started).
    const spawnReject = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Worker that will reject steer",
        dispatchKey: "g8-f5-provider-reject",
      },
      localAuth,
    );
    assert.equal(spawnReject.outcome, "applied", JSON.stringify(spawnReject));
    const rejectSessionId = String(spawnReject.runtimeSessionId);
    await waitForProviderBound(f.host, rejectSessionId, localAuth);

    const rejectSteer = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: rejectSessionId,
        prompt: "Trigger provider rejection [REJECT_STEER]",
        idempotencyKey: "ctrl-f5-provider-reject",
      },
      localAuth,
    );
    assert.equal(rejectSteer.outcome, "applied", JSON.stringify(rejectSteer));

    // Wait for session to finish exiting and assert ONLY a rejected controlReceipt exists (NEVER applied)!
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [rejectSessionId] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: rejectSessionId, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.controlRequestId === "ctrl-f5-provider-reject" &&
            rcpt.status === "rejected" &&
            rcpt.reasonCode === "steer_dropped",
        ),
      );
    });
    const rejectRead = await f.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: rejectSessionId, includeControlReceipts: true },
      localAuth,
    );
    assert.equal(
      rejectRead.session?.controlReceipts?.some(
        (rcpt) => rcpt.controlRequestId === "ctrl-f5-provider-reject" && rcpt.status === "applied",
      ),
      false,
      "provider rejection must never emit an applied receipt",
    );

    // Part B: Transient Center disconnect between steer outcome generation on Edge and Center ACK!
    const spawnDisconnect = await edgeA.host.spawnRuntime(
      repoId,
      {
        runtimeInstanceId: "node-one-codex",
        cwd: { scope: "repo-root" },
        prompt: "Worker alive across receipt-ACK disconnect",
        dispatchKey: "g8-f5-receipt-disconnect",
      },
      localAuth,
    );
    assert.equal(spawnDisconnect.outcome, "applied", JSON.stringify(spawnDisconnect));
    const disconnectSessionId = String(spawnDisconnect.runtimeSessionId);
    await waitForProviderBound(f.host, disconnectSessionId, localAuth);

    const disconnectSteer = await f.host.steerRuntime(
      repoId,
      {
        runtimeSessionId: disconnectSessionId,
        prompt: "Steer whose applied receipt is generated during Center outage",
        idempotencyKey: "ctrl-f5-receipt-disconnect",
      },
      localAuth,
    );
    assert.equal(disconnectSteer.outcome, "applied", JSON.stringify(disconnectSteer));

    // Wait until the resumed provider has started (waiting at resumeGateFile before emitting thread.started).
    await waitForDurableCondition(async () => existsSync(resumeStartedFile));

    // Drop Center TLS BEFORE the provider emits thread.started (so steer_resumed is generated while Center is offline!).
    const centerPort = f.center.port;
    await f.center.close();
    writeFileSync(resumeGateFile, "go");

    // Wait briefly so Edge observes steer_resumed and its initial publish attempt hits the closed Center socket.
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Reopen Center TLS on the same port: Edge reconciles and durably replays the unacknowledged applied receipt!
    await f.openCenter(f.host, centerPort);
    await waitForDurableCondition(async () => {
      const read = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: disconnectSessionId, includeControlReceipts: true },
        localAuth,
      );
      return Boolean(
        read.session?.controlReceipts?.some(
          (rcpt) =>
            rcpt.controlRequestId === "ctrl-f5-receipt-disconnect" &&
            rcpt.status === "applied" &&
            rcpt.steerVersion === 1,
        ),
      );
    });

    // Cleanly stop the remaining session.
    await f.host.cancelRuntime(repoId, { runtimeSessionId: disconnectSessionId }, localAuth);
    await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [disconnectSessionId] },
      { ...localAuth, connectionSignal: AbortSignal.timeout(30_000) },
    );
  },
);
