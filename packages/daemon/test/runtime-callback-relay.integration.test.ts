// harness-test-tier: integration
import assert from "node:assert/strict";
import { adoptNativeProcess, launchNative } from "../src/runtime-spawn-process.ts";
import { randomBytes } from "node:crypto";
import net from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonRpcLineClient } from "../src/client/local-json-rpc-client.ts";
import { runtimeExecutionActor, type RuntimeExecutionPrincipal } from "../src/runtime-execution-credential.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import {
  localUserDaemonEndpoint,
  perUserSocketRoot,
  resolveLocalDaemonEndpoint,
} from "../src/client/local-daemon-target.ts";
import {
  createRuntimeCallbackRelay,
  removeRuntimeCallbackRelay,
  runtimeCallbackRelaySpec,
  validateRuntimeCallbackRelayPath,
} from "../src/runtime-callback-relay.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";

/** Real relay sockets share one per-user namespace across concurrently running test files,
 * so every live-socket test mints its own dispatch id instead of reusing a fixed one. */
const uniqueDispatchId = (): string => `dispatch_${randomBytes(12).toString("hex")}`;

test(
  "callback relay attributes a credential-omitting runtime write to its execution",
  { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-identity-")),
      userRoot = path.join(parent, "daemon-user"),
      dispatchId = uniqueDispatchId(),
      daemonId = "callback-relay-identity",
      executionCredential = "execution-credential-from-spawn",
      repoId = "repo-callback-relay-identity",
      runtimeSessionId = "runtime_callback_relay_identity",
      taskId = "task-callback-relay-identity",
      principal: RuntimeExecutionPrincipal = {
        personId: "owner",
        repoId,
        runtimeSessionId,
        dispatchId,
        taskId,
        executionId: "exec-callback-relay-identity",
        role: "implementation",
        source: "local",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(path.join(parent, "repo", ".harness", "runtime", "dispatches"), { recursive: true });
    writeFileSync(path.join(parent, "repo", ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`), "");
    const root = path.join(parent, "repo"),
      expectedEndpoint = localUserDaemonEndpoint(userRoot, daemonId),
      route = { userRoot, daemonId, endpoint: `\0${path.basename(expectedEndpoint)}` },
      spec = runtimeCallbackRelaySpec(dispatchId, route),
      hello = {
        jsonrpc: "2.0",
        id: 1,
        method: "protocol.hello",
        params: { protocolVersion: currentDaemonProtocolVersion },
      },
      write = {
        jsonrpc: "2.0",
        id: 2,
        method: "repo.task.run",
        params: {
          repo: { repoId },
          payload: { action: { kind: "task-progress-append", taskId, text: "relay write" } },
        },
      },
      executablePath = writeProviderExecutable(
        path.join(parent, "provider.mjs"),
        `import net from "node:net"; let buffered = ""; let sentWrite = false; const socket = net.createConnection(process.env.HARNESS_DAEMON_ENDPOINT); socket.on("connect", () => socket.write(${JSON.stringify(`${JSON.stringify(hello)}\n`)})); socket.on("data", (chunk) => { buffered += chunk.toString("utf8"); const lines = buffered.split("\\n"); buffered = lines.pop() ?? ""; for (const line of lines) { const frame = JSON.parse(line); if (frame.id === 1 && !sentWrite) { sentWrite = true; socket.write(${JSON.stringify(`${JSON.stringify(write)}\n`)}); } else if (frame.id === 2) { socket.destroy(); process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "callback-relay-identity" }) + "\\n"); process.exit(0); } } });`,
      );
    let recordedActor: unknown;
    const privateServer = net.createServer((socket) => {
      serveJsonRpcStream({
        input: socket,
        output: socket,
        transportKind: "unix-socket",
        authContext: { transportKind: "unix-socket" },
        createProtocolServer: (authContext, emit, connectionId, signal) =>
          createJsonRpcProtocolServer({
            host: {
              run: async (_repo: string, _action: unknown, auth: typeof authContext) => {
                recordedActor = auth.executionPrincipal
                  ? runtimeExecutionActor(auth.executionPrincipal)
                  : { principal: { personId: auth.oidcPrincipal?.personId }, executor: null };
                return { outcome: "applied" };
              },
            } as never,
            build: { commit: null },
            authContext: { ...authContext, connectionSignal: signal },
            executionPrincipal: async (credential) => {
              assert.equal(credential, executionCredential);
              return principal;
            },
            sessionPrincipal: async () => ({
              personId: "owner",
              subject: "owner-subject",
              accessToken: "session-token",
              expiresAt: Date.now() + 60_000,
              authority: { url: "https://authority.invalid", realm: "test", clientId: "harness-center" },
            }),
            emit,
            connectionId,
          }),
      });
    });
    await listen(privateServer, route.endpoint);
    let runtime: ReturnType<typeof launchNative> | null = null;
    try {
      runtime = launchNative(
        {
          executablePath,
          args: [],
          env: {
            HARNESS_DAEMON_USER_ROOT: userRoot,
            HARNESS_DAEMON_ID: daemonId,
            HARNESS_DAEMON_ENDPOINT: spec.path,
            HARNESS_EXECUTION_CREDENTIAL: executionCredential,
          },
          cwd: root,
          prompt: "",
          installation: { kindId: "codex" },
          protocolFamily: "codex",
          permissionMode: "workspace-write",
        } as never,
        { rootDir: root, dispatchId, callbackRelay: spec },
      );
      await eventuallyRelay(() => recordedActor !== undefined);
      assert.deepEqual(recordedActor, {
        principal: { personId: "owner" },
        executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
      });
      await runtime.terminateTree?.();
      recordedActor = undefined;
      const socket = await new Promise<net.Socket>((resolve, reject) => {
          const clientSocket = net.createConnection(route.endpoint);
          clientSocket.once("connect", () => resolve(clientSocket));
          clientSocket.once("error", reject);
        }),
        client = new JsonRpcLineClient(socket, socket);
      try {
        await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
        await client.request("repo.task.run", write.params);
      } finally {
        client.close();
        socket.destroy();
      }
      assert.deepEqual(recordedActor, { principal: { personId: "owner" }, executor: null });
    } finally {
      await runtime?.terminateTree?.();
      await new Promise<void>((resolve) => privateServer.close(() => resolve()));
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "callback relay forwards the sealed route and cleans up after settlement",
  { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(root, "daemon-user"),
      daemonId = "callback-relay",
      dispatchId = uniqueDispatchId();
    mkdirSync(userRoot, { recursive: true });
    const expectedEndpoint = localUserDaemonEndpoint(userRoot, daemonId),
      privateEndpoint = `\0${path.basename(expectedEndpoint)}`,
      route = { userRoot, daemonId, endpoint: privateEndpoint };
    const privateServer = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(`ack:${chunk.toString("utf8")}`));
    });
    await listen(privateServer, privateEndpoint);
    const spec = runtimeCallbackRelaySpec(dispatchId, route);
    const relay = createRuntimeCallbackRelay({ dispatchId, route, relayPath: spec.path });
    try {
      await relay.start();
      assert.notEqual(relay.endpoint, route.endpoint);
      assert.equal(path.dirname(relay.endpoint), perUserSocketRoot());
      const client = await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(relay.endpoint);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
      try {
        const response = new Promise<string>((resolve) =>
          client.once("data", (chunk) => resolve(chunk.toString("utf8"))),
        );
        client.write("policy-authorized-callback");
        assert.equal(await response, "ack:policy-authorized-callback");
      } finally {
        client.destroy();
      }
      await relay.stop();
      assert.equal(existsSync(spec.path), false);
      assert.equal(existsSync(path.dirname(spec.path)), true);
    } finally {
      await relay.stop();
      await new Promise<void>((resolve) => privateServer.close(() => resolve()));
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "callback relay starts and forwards on a repository root longer than the socket address limit",
  { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-long-")),
      // One >104-byte socket path is the incident shape: the workspace contributes so many
      // bytes that any socket under it would exceed the macOS sun_path limit.
      padded = "p".repeat(140),
      root = path.join(parent, padded, "repo"),
      userRoot = path.join(parent, "daemon-user"),
      dispatchId = uniqueDispatchId(),
      daemonId = "callback-relay-long";
    mkdirSync(root, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const route = { userRoot, daemonId, endpoint: `\0${path.basename(localUserDaemonEndpoint(userRoot, daemonId))}` },
      workspaceSocketBytes = Buffer.byteLength(
        path.join(root, ".harness", `r-${dispatchId.slice("dispatch_".length)}.sock`),
      );
    assert.equal(workspaceSocketBytes > 104, true);
    const privateServer = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(`ack:${chunk.toString("utf8")}`));
    });
    await listen(privateServer, route.endpoint);
    const spec = runtimeCallbackRelaySpec(dispatchId, route);
    assert.equal(Buffer.byteLength(spec.path) <= 104, true);
    const relay = createRuntimeCallbackRelay({ dispatchId, route, relayPath: spec.path });
    try {
      await relay.start();
      const client = await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(relay.endpoint);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
      assert.equal(statSync(path.dirname(spec.path)).mode & 0o777, 0o700);
      try {
        const response = new Promise<string>((resolve) =>
          client.once("data", (chunk) => resolve(chunk.toString("utf8"))),
        );
        client.write("long-root-callback");
        assert.equal(await response, "ack:long-root-callback");
      } finally {
        client.destroy();
      }
    } finally {
      await relay.stop();
      await new Promise<void>((resolve) => privateServer.close(() => resolve()));
      assert.equal(existsSync(spec.path), false);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "concurrent dispatch relays keep distinct endpoints and cleanup removes only its own socket",
  { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-pair-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "daemon-user"),
      firstDispatch = uniqueDispatchId(),
      secondDispatch = uniqueDispatchId(),
      daemonId = "callback-relay-pair";
    mkdirSync(root, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const route = { userRoot, daemonId, endpoint: `\0${path.basename(localUserDaemonEndpoint(userRoot, daemonId))}` },
      privateServer = net.createServer((socket) => {
        socket.on("data", (chunk) => socket.write(`ack:${chunk.toString("utf8")}`));
      });
    await listen(privateServer, route.endpoint);
    const firstSpec = runtimeCallbackRelaySpec(firstDispatch, route),
      secondSpec = runtimeCallbackRelaySpec(secondDispatch, route);
    assert.notEqual(firstSpec.path, secondSpec.path);
    const first = createRuntimeCallbackRelay({ dispatchId: firstDispatch, route, relayPath: firstSpec.path }),
      second = createRuntimeCallbackRelay({ dispatchId: secondDispatch, route, relayPath: secondSpec.path });
    try {
      await first.start();
      await second.start();
      await assert.equal(await echo(firstSpec.path, "first-dispatch"), "ack:first-dispatch");
      await assert.equal(await echo(secondSpec.path, "second-dispatch"), "ack:second-dispatch");
      removeRuntimeCallbackRelay(firstDispatch);
      assert.equal(existsSync(firstSpec.path), false);
      assert.equal(existsSync(secondSpec.path), true);
      await assert.equal(await echo(secondSpec.path, "second-still-live"), "ack:second-still-live");
    } finally {
      await first.stop();
      await second.stop();
      await new Promise<void>((resolve) => privateServer.close(() => resolve()));
      assert.equal(existsSync(firstSpec.path), false);
      assert.equal(existsSync(secondSpec.path), false);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

for (const forceTerminate of [false, true])
  test(
    forceTerminate
      ? "adopted observer cleans up the relay after forced termination"
      : "observer release preserves a live relay until the worker settles",
    { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
    async () => {
      const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-release-")),
        root = path.join(parent, "repo"),
        userRoot = path.join(parent, "daemon-user"),
        daemonId = "callback-relay-release",
        dispatchId = uniqueDispatchId(),
        marker = path.join(parent, "provider-started"),
        settle = path.join(parent, "provider-settle"),
        executablePath = writeProviderExecutable(
          path.join(parent, "provider.mjs"),
          `import fs from "node:fs"; process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ endpoint: process.env.HARNESS_DAEMON_ENDPOINT, userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID })); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(settle)})) return; clearInterval(timer); process.exit(0); }, 10);`,
        );
      mkdirSync(root, { recursive: true });
      mkdirSync(userRoot, { recursive: true });
      mkdirSync(path.join(root, ".harness", "runtime", "dispatches"), { recursive: true });
      writeFileSync(path.join(root, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`), "");
      const expectedEndpoint = localUserDaemonEndpoint(userRoot, daemonId),
        privateEndpoint = `\0${path.basename(expectedEndpoint)}`,
        route = { userRoot, daemonId, endpoint: privateEndpoint },
        privateServer = net.createServer((socket) => {
          socket.on("data", (chunk) => socket.write(`ack:${chunk.toString("utf8")}`));
        });
      await listen(privateServer, privateEndpoint);
      const spec = runtimeCallbackRelaySpec(dispatchId, route);
      let runtime: ReturnType<typeof launchNative> | null = null;
      try {
        runtime = launchNative(
          {
            definition: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId: "codex-release",
              installationId: "installation-codex-release",
              kindId: "codex",
              providerId: "openai",
              model: "codex-model",
              reasoningEffort: null,
              baseUrl: null,
              authMode: "subscription",
            },
            installation: {
              installationId: "installation-codex-release",
              kindId: "codex",
              executablePath,
              version: "1.0.0",
              observedAt: "2026-09-04T00:00:00.000Z",
            },
            executablePath,
            args: [],
            env: {
              HARNESS_DAEMON_USER_ROOT: userRoot,
              HARNESS_DAEMON_ID: daemonId,
              HARNESS_DAEMON_ENDPOINT: spec.path,
              HARNESS_DAEMON_RELAY: "1",
            },
            cwd: root,
            prompt: "",
          },
          { rootDir: root, dispatchId, callbackRelay: spec },
        );
        await eventuallyRelay(() => existsSync(marker) && existsSync(spec.path));
        assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { endpoint: spec.path, userRoot, daemonId });
        runtime.release?.();
        assert.equal(existsSync(spec.path), true);
        const adopted = adoptNativeProcess(root, dispatchId, runtime.pid);
        try {
          assert.equal(await echo(spec.path, "after-observer-release"), "ack:after-observer-release");
          if (forceTerminate) {
            await adopted.terminateTree?.();
            assert.equal(existsSync(spec.path), false);
            const records = readFileSync(
              path.join(root, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`),
              "utf8",
            );
            assert.equal(records.includes('"kind":"process_exit"'), false);
            assert.equal(records.includes('"kind":"process_descendants_terminated"'), true);
          }
        } finally {
          adopted.release?.();
        }
        writeFileSync(settle, "settle");
        await eventuallyRelay(() => !existsSync(spec.path));
      } finally {
        await runtime?.terminateTree?.();
        await new Promise<void>((resolve) => privateServer.close(() => resolve()));
        assert.equal(existsSync(spec.path), false);
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

test(
  "callback relay rejects mismatched routes, escaping paths, symlinked sockets, and foreign endpoints",
  { skip: process.platform === "win32" },
  () => {
    const root = path.resolve(".callback-relay-validation"),
      userRoot = path.join(root, "daemon-user"),
      route = {
        userRoot,
        daemonId: "callback-validation",
        endpoint: localUserDaemonEndpoint(userRoot, "callback-validation"),
      },
      dispatchId = "dispatch_abcdef0123456789abcdef01",
      spec = runtimeCallbackRelaySpec(dispatchId, route),
      mismatch = { ...route, endpoint: localUserDaemonEndpoint(path.join(root, "other-user"), route.daemonId) };
    rmSync(root, { recursive: true, force: true });
    mkdirSync(userRoot, { recursive: true });
    try {
      assert.throws(
        () => createRuntimeCallbackRelay({ dispatchId, route: mismatch, relayPath: spec.path }),
        /endpoint identity/u,
      );
      assert.throws(
        () => validateRuntimeCallbackRelayPath(dispatchId, path.join(root, "outside.sock")),
        /relay path is invalid/u,
      );
      assert.equal(
        resolveLocalDaemonEndpoint({
          userRoot,
          daemonId: route.daemonId,
          canonicalRoot: root,
          env: { HARNESS_DAEMON_ENDPOINT: spec.path, HARNESS_DAEMON_RELAY: "1" },
        }),
        spec.path,
      );
      // A foreign socket in the same workspace is not a valid relay target: the accepted
      // endpoint must sit under the per-user socket root with the per-dispatch name.
      const foreign = path.join(root, ".harness", `r-${dispatchId.slice("dispatch_".length)}.sock`);
      mkdirSync(path.dirname(foreign), { recursive: true });
      assert.throws(
        () =>
          resolveLocalDaemonEndpoint({
            userRoot,
            daemonId: route.daemonId,
            canonicalRoot: root,
            env: { HARNESS_DAEMON_ENDPOINT: foreign, HARNESS_DAEMON_RELAY: "1" },
          }),
        /daemon_target_conflict/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // A symlinked socket file at the relay path is refused at materialization instead of
    // being unlinked or bound through.
    const symlinkDispatch = uniqueDispatchId(),
      symlinkRoute = { userRoot, daemonId: "callback-validation", endpoint: route.endpoint },
      symlinkSpec = runtimeCallbackRelaySpec(symlinkDispatch, symlinkRoute);
    try {
      symlinkSync(path.join(root, "outside"), symlinkSpec.path);
      assert.throws(
        () =>
          createRuntimeCallbackRelay({ dispatchId: symlinkDispatch, route: symlinkRoute, relayPath: symlinkSpec.path }),
        /must not be a symbolic link/u,
      );
    } finally {
      rmSync(symlinkSpec.path, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("stale callback relay cleanup removes only its validated dispatch socket", () => {
  const keptDispatch = uniqueDispatchId(),
    removedDispatch = uniqueDispatchId(),
    keptPath = path.join(perUserSocketRoot(), `r-${keptDispatch.slice("dispatch_".length)}.sock`),
    removedPath = path.join(perUserSocketRoot(), `r-${removedDispatch.slice("dispatch_".length)}.sock`);
  mkdirSync(path.dirname(keptPath), { recursive: true, mode: 0o700 });
  writeFileSync(removedPath, "stale");
  try {
    removeRuntimeCallbackRelay(removedDispatch);
    assert.equal(existsSync(removedPath), false);
    writeFileSync(keptPath, "live");
    removeRuntimeCallbackRelay(removedDispatch);
    assert.equal(existsSync(keptPath), true);
  } finally {
    rmSync(removedPath, { force: true });
    rmSync(keptPath, { force: true });
  }
});

async function echo(endpoint: string, payload: string): Promise<string> {
  const client = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
  try {
    const response = new Promise<string>((resolve) => client.once("data", (chunk) => resolve(chunk.toString("utf8"))));
    client.write(payload);
    return await response;
  } finally {
    client.destroy();
  }
}

async function eventuallyRelay(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("callback relay did not start");
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve();
    });
  });
}
