import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { waitForArrival, watchDirectoryArrival } from "../../../../../tools/fixtures/event-arrival.ts";
import { requestDaemonJsonRpcAt } from "../../../src/client/local-json-rpc-client.ts";
import { applyFleetMirrorCut } from "../../../src/fleet-edge-mirror.ts";
import { listenFleetTls } from "../../../src/fleet/center.ts";
import { authenticateRuntimeExecutionPrincipal } from "../../../src/runtime-execution-credential.ts";
import { startDaemon } from "../../../src/runtime.ts";
import { fleetFixture, git } from "../../fleet-runtime-recovery.fixtures.ts";
import { fleetHostWriterOptions } from "../../fleet-store.fixture.ts";
import { IdentitySessionPort, keycloakSessionStore } from "../../keycloak.fixtures.ts";
import { catchUpReplica } from "../../replica-catch-up.fixture.ts";
import { registerBootstrappedDaemonRepo } from "../../repo-settings.fixture.ts";
import { spawnCli } from "../runtime-ingress.ts";
import { writeProviderExecutable } from "../runtime-stub.ts";
import { readLocalIdentity, waitForLocalIdentityRetirement } from "./local-identity.ts";

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real provider, socket, Fleet TLS and writer. Only the accepted terminal response is parked. */
export async function settledIdentityFixture(t: TestContext, label: string) {
  let cleanup = async () => {};
  t.after(() => cleanup());
  const f = await fleetFixture(t, ["tasks/task-fleet-fleet"], [], "local", undefined, [
    { instanceId: "edge-worker", enabled: true },
  ]);
  // Match the original logout fixture's declared HTTPS login authority. Its existing isolated
  // Keycloak answers the HTTPS fetches; no principal lookup or authorization result is replaced.
  const loginAuthorityUrl = "https://keycloak.fixture:443";
  const centerConfigPath = path.join(f.root, "user/rbac/config.json");
  writeFileSync(
    centerConfigPath,
    JSON.stringify({
      ...JSON.parse(readFileSync(centerConfigPath, "utf8")),
      listener: {
        address: "127.0.0.1",
        hostname: "keycloak.fixture",
        port: 443,
        certificateFile: f.certFile,
        certificateKeyFile: path.join(f.root, "tls.key"),
      },
    }),
  );
  f.owners.keycloak.interactiveSession(
    "person-owner",
    f.subject.nodeId,
    loginAuthorityUrl,
    `device-token-${f.subject.nodeId}`,
  );
  const networkFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith(loginAuthorityUrl) ? f.owners.keycloak.fetch(input, init) : networkFetch(input, init),
  );
  let sequence = 0;
  const observe = (event: string, data: Readonly<Record<string, unknown>>) => {
    const entry = { sequence: ++sequence, label, event, ...data };
    // Only ids, states and receipts enter evidence; the execution credential stays in the fixture.
    console.log(`[settled-identity] ${JSON.stringify(entry)}`);
    return entry;
  };
  observe("environment", { node: process.version, platform: process.platform, arch: process.arch });
  const accepted = signal<Readonly<Record<string, unknown>>>(),
    release = signal<void>();
  let runtimeId: string | null = null;
  const center = await f.hold(
    listenFleetTls({
      host: {
        ...f.host,
        run: async (...args) => {
          if (args[1].kind === "task-progress-append")
            observe("center-command-ingress", {
              dispatchId: args[2].executionPrincipal?.dispatchId ?? null,
              runtimeSessionId: args[2].executionPrincipal?.runtimeSessionId ?? null,
            });
          const receipt = await f.host.run(...args);
          if (args[1].kind === "task-progress-append") observe("center-command-receipt", { receipt });
          return receipt;
        },
        runtimeIngress: async (...args) => {
          const receipt = await f.host.runtimeIngress(...args);
          const ingress = args[1];
          if (ingress.kind === "archive") observe("center-archive-receipt", { receipt });
          if (ingress.kind === "event" && ingress.type === "runtime_session_outcome_observed") {
            observe("center-terminal-receipt", { receipt });
            if (ingress.payload.runtimeSessionId === runtimeId) {
              accepted.resolve(receipt);
              await release.promise;
              observe("terminal-response-released", { runtimeSessionId: runtimeId });
            }
          }
          return receipt;
        },
      },
      stateRoot: f.stateRoot,
      ...fleetHostWriterOptions(path.join(f.root, "user"), [f.subject.repoId]),
      key: f.key,
      cert: f.cert,
      replicaDiskQuotaBytes: 64 * 1024 * 1024,
      authenticate: (nodeId, credential) => nodeId === f.subject.nodeId && credential === "machine-secret",
      nodeOwner: f.owners.nodeOwner,
      verifyHuman: f.owners.verifyHuman,
      authenticateExecutionPrincipal: (credential) =>
        authenticateRuntimeExecutionPrincipal(() => f.host.identityCenter(), credential),
      loginAuthority: (nodeId) => ({ url: loginAuthorityUrl, realm: "harness", clientId: `harness-node-${nodeId}` }),
    }),
  );
  const edgeRoot = path.join(f.root, "edge"),
    userRoot = path.join(f.root, "edge-user"),
    viewRoot = path.join(f.root, "view"),
    repoId = f.subject.repoId,
    taskId = f.subject.taskId;
  git(f.root, "clone", f.repo, edgeRoot);
  git(edgeRoot, "config", "user.name", "Fleet Test");
  git(edgeRoot, "config", "user.email", "fleet@example.invalid");
  const config = {
    schema: "fleet-edge-config/v1",
    host: "127.0.0.1",
    port: center.port,
    caPath: f.certFile,
    servername: "localhost",
    nodeId: f.subject.nodeId,
    credential: "machine-secret",
    repoId,
    viewRoot,
    quotaBytes: 64 * 1024 * 1024,
    waitTimeoutMs: 5000,
  };
  writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
  await catchUpReplica({
    ...config,
    ca: f.cert,
    readAccessToken: f.owners.readAccessToken(config.nodeId),
    diskQuotaBytes: config.quotaBytes,
  });
  applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
  mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
  writeFileSync(
    path.join(userRoot, "rbac/config.json"),
    JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external" }),
  );
  const issuer = `${loginAuthorityUrl}/realms/harness`;
  keycloakSessionStore(userRoot, issuer).write(
    JSON.stringify({
      schema: "harness-oidc-session/v3",
      issuer,
      accessToken: `device-token-${config.nodeId}`,
      subject: "person-owner",
      personId: "person-owner",
      expiresAt: Date.now() + 3_600_000,
      roles: [],
      loginTarget: edgeRoot,
    }),
  );
  registerBootstrappedDaemonRepo({
    canonicalRoot: edgeRoot,
    repoId,
    mode: "remote-edge",
    userRoot,
    createConvenienceLinks: false,
  });
  await IdentitySessionPort(userRoot).status(edgeRoot);
  const environment = signal<NodeJS.ProcessEnv>();
  const receiver = createServer((socket) => {
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      body += chunk;
    });
    socket.on("end", () => environment.resolve(JSON.parse(body) as NodeJS.ProcessEnv));
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  assert.ok(address && typeof address !== "string");
  // The provider sends its environment over a private loopback observation channel. Credentials
  // never enter an environment file, stdout, assertion message or retained task artifact.
  cleanup = async () => {
    receiver.close();
  };
  const provider = writeProviderExecutable(
    path.join(f.root, "provider.mjs"),
    `
    import fs from "node:fs"; import path from "node:path"; import net from "node:net";
    if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);
    fs.readFileSync(0, "utf8");
    const id = process.env.HARNESS_ACTOR.split(":").at(-1), root = ${JSON.stringify(f.root)};
    const keys = ["HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT", "HARNESS_ACTOR", "HARNESS_DAEMON_USER_ROOT", "HARNESS_DAEMON_ID", "HARNESS_DAEMON_ENDPOINT", "HARNESS_DAEMON_REPO_ID", "HARNESS_CANONICAL_ROOT", "HARNESS_TASK_BOUND", "HARNESS_DAEMON_RELAY", "HARNESS_DAEMON_REMOTE_EDGE"];
    net.createConnection({ host: "127.0.0.1", port: ${address.port} }).end(JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))));
    console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
    const finish = () => { if (!fs.existsSync(path.join(root, id + ".finish"))) return;
      watcher.close(); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Identity experiment completed." } }));
      console.log(JSON.stringify({ type: "turn.completed" })); };
    const watcher = fs.watch(root, finish); finish();
  `,
  );
  const daemon = await startDaemon({
    userRoot,
    daemonId: "settled-identity",
    buildSupersessionEnabled: false,
    runtimeDiscover: () => [
      {
        installationId: "edge-install",
        kindId: "codex",
        executablePath: provider,
        version: "fixture",
        observedAt: new Date().toISOString(),
      },
    ],
  });
  assert.ok("stop" in daemon);
  // Release the asynchronous response before stopping the edge, even after an assertion fails.
  cleanup = async () => {
    release.resolve();
    if (runtimeId) writeFileSync(path.join(f.root, `${runtimeId}.finish`), "finish");
    await daemon.stop();
    receiver.close();
  };
  const rpc = (method: string, params: Record<string, unknown>) =>
    requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000);
  await waitForArrival(async () => {
    const status = await rpc("daemon.status", {});
    const row = (status.repos as Record<string, unknown>[])?.find((repo) => repo.repoId === repoId);
    assert.notEqual(row?.state, "unavailable", JSON.stringify(status));
    return row?.state === "attached" ? true : null;
  }, watchDirectoryArrival(f.root));
  const created = await rpc("daemon.runtimeInstance.create", {
    payload: {
      instanceId: "edge-worker",
      name: "Edge worker",
      kindId: "codex",
      installationId: "edge-install",
      providerId: "openai",
      models: ["fixture"],
      permissionMode: "workspace-write",
      authMode: "subscription",
    },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const spawned = await rpc("repo.agentRuntime.spawn", {
    repo: { repoId },
    payload: {
      runtimeInstanceId: "edge-worker",
      taskId,
      prompt: "Observe settled identity",
      dispatchKey: `identity-${label}`,
    },
  });
  assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
  runtimeId = String(spawned.runtimeSessionId);
  const dispatchId = String(spawned.dispatchId);
  observe("spawned", { repoId, taskId, executionId: f.subject.executionId, runtimeSessionId: runtimeId, dispatchId });
  const env = await environment.promise;
  const credential = env.HARNESS_EXECUTION_CREDENTIAL;
  assert.ok(credential);
  const identity = {
    rootDir: edgeRoot,
    dispatchId,
    credential,
    expiresAt: env.HARNESS_EXECUTION_EXPIRES_AT!,
  };
  const state = () => readLocalIdentity(identity);
  const direct = async () => {
    const result = await spawnCli(
      [
        "--root",
        path.join(edgeRoot, ".worktrees", taskId),
        "--json",
        "task",
        "progress",
        "append",
        taskId,
        "--text",
        "Identity boundary probe.",
      ],
      {
        ...process.env,
        ...env,
        HARNESS_DAEMON_ENDPOINT: daemon.endpoint,
        HARNESS_DAEMON_RELAY: undefined,
      },
    );
    assert.ok(result.stdout.trim(), result.stderr);
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    observe("direct-receipt", { runtimeSessionId: runtimeId, dispatchId, status: result.status, receipt });
    return receipt;
  };
  const lifecycle = async () => {
    const read = await f.host.readDispatchLifecycle(repoId, { by: "session", runtimeSessionId: runtimeId! }, f.auth);
    observe("canonical-lifecycle", { read });
    assert.equal(read.status, "ready");
    if (read.status !== "ready") throw new Error("canonical lifecycle pending");
    assert.equal(read.rows.length, 1);
    return read;
  };
  const finish = async () => {
    writeFileSync(path.join(f.root, `${runtimeId}.finish`), "finish");
    const receipt = await accepted.promise;
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const read = await lifecycle();
    assert.equal(read.rows[0]!.policy.canWrite, false);
    assert.equal(read.rows[0]!.policy.attemptSettled, true);
    observe("terminal-response-held", { runtimeSessionId: runtimeId, dispatchId, ...state() });
    return read;
  };
  const releaseTerminal = () => {
    const entry = observe("release-requested", { dispatchId });
    release.resolve();
    return entry;
  };
  const awaitArchive = () =>
    waitForLocalIdentityRetirement(identity, (value) => observe("identity-retirement-observed", value));
  return { observe, state, direct, lifecycle, finish, releaseTerminal, awaitArchive };
}
