// harness-test-tier: integration
import assert from "node:assert/strict";
import { adoptNativeProcess, launchNative } from "../src/runtime-spawn-process.ts";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { localUserDaemonEndpoint, resolveLocalDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import {
  createRuntimeCallbackRelay,
  removeRuntimeCallbackRelay,
  runtimeCallbackRelaySpec,
  validateRuntimeCallbackRelayPath,
} from "../src/runtime-callback-relay.ts";

test(
  "workspace callback relay forwards the sealed route and cleans up after settlement",
  { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(root, "daemon-user"),
      daemonId = "callback-relay",
      dispatchId = "dispatch_0123456789abcdef01234567";
    mkdirSync(userRoot, { recursive: true });
    const expectedEndpoint = localUserDaemonEndpoint(userRoot, daemonId),
      privateEndpoint = `\0${path.basename(expectedEndpoint)}`,
      route = { userRoot, daemonId, endpoint: privateEndpoint };
    const privateServer = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(`ack:${chunk.toString("utf8")}`));
    });
    await listen(privateServer, privateEndpoint);
    const spec = runtimeCallbackRelaySpec(root, dispatchId, route);
    const relay = createRuntimeCallbackRelay({ rootDir: root, dispatchId, route, relayPath: spec.path });
    try {
      await relay.start();
      assert.notEqual(relay.endpoint, route.endpoint);
      assert.equal(relay.endpoint.startsWith(path.join(root, ".harness")), true);
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
  "observer release preserves a live relay until the worker settles",
  { skip: process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" || process.platform === "win32" },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-callback-relay-release-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "daemon-user"),
      daemonId = "callback-relay-release",
      dispatchId = "dispatch_abcdef0123456789abcdef01",
      marker = path.join(parent, "provider-started"),
      settle = path.join(parent, "provider-settle"),
      executablePath = writeProviderExecutable(
        path.join(parent, "provider.mjs"),
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ endpoint: process.env.HARNESS_DAEMON_ENDPOINT, userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID })); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(settle)})) return; clearInterval(timer); process.exit(0); }, 10);`,
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
    const spec = runtimeCallbackRelaySpec(root, dispatchId, route);
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
      assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { endpoint: spec.path });
      runtime.release?.();
      assert.equal(existsSync(spec.path), true);
      const adopted = adoptNativeProcess(root, dispatchId, runtime.pid);
      try {
        const client = await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(spec.path);
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        });
        try {
          const response = new Promise<string>((resolve) =>
            client.once("data", (chunk) => resolve(chunk.toString("utf8"))),
          );
          client.write("after-observer-release");
          assert.equal(await response, "ack:after-observer-release");
        } finally {
          client.destroy();
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
  "callback relay rejects mismatched, escaping, and symlinked routes",
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
      spec = runtimeCallbackRelaySpec(root, dispatchId, route),
      mismatch = { ...route, endpoint: localUserDaemonEndpoint(path.join(root, "other-user"), route.daemonId) };
    rmSync(root, { recursive: true, force: true });
    mkdirSync(userRoot, { recursive: true });
    try {
      assert.throws(
        () =>
          createRuntimeCallbackRelay({
            rootDir: root,
            dispatchId,
            route: mismatch,
            relayPath: spec.path,
          }),
        /endpoint identity/u,
      );
      assert.throws(
        () => validateRuntimeCallbackRelayPath(root, dispatchId, path.join(root, "outside.sock"), route),
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
      symlinkSync(path.join(root, "outside"), path.join(root, ".harness"));
      assert.throws(
        () => createRuntimeCallbackRelay({ rootDir: root, dispatchId, route, relayPath: spec.path }),
        /symbolic link/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("stale callback relay cleanup removes only its validated dispatch socket", () => {
  const root = path.resolve(".callback-relay-stale"),
    dispatchId = "dispatch_0123456789abcdef01234567",
    relayPath = path.join(root, ".harness", "r-0123456789abcdef01234567.sock");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.dirname(relayPath), { recursive: true });
  writeFileSync(relayPath, "stale");
  try {
    removeRuntimeCallbackRelay(root, dispatchId);
    assert.equal(existsSync(relayPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
