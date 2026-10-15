// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";
import {
  DEFAULT_GUI_CONNECT_TIMEOUT_MS,
  DEFAULT_GUI_REQUEST_TIMEOUT_MS,
  guiRequestTimeouts,
} from "../src/main/gui-local-settings.ts";

const cases = [
  {
    method: "createRuntimeInstance",
    payload: {
      instanceId: "test",
      kindId: "codex",
      name: "fixture",
      providerId: "openai",
      models: ["model"],
      defaultModel: "model",
      authMode: "subscription",
    },
    elapsed: 2_001,
  },
  { method: "listRuntimeInstances", payload: { all: true }, elapsed: 2_001 },
  { method: "updateRuntimeInstance", payload: { instanceId: "test", enabled: false }, elapsed: 2_001 },
  { method: "updateRuntimeInstance", payload: { instanceId: "test", enabled: true }, elapsed: 2_001 },
  { method: "updateRuntimeInstance", payload: { instanceId: "test", name: "edited" }, elapsed: 2_001 },
  { method: "deleteRuntimeInstance", payload: { instanceId: "test" }, elapsed: 2_001 },
  { method: "updateRuntimeInstance", payload: { instanceId: "test", apiKey: "fixture-only" }, elapsed: 20_001 },
  {
    method: "updateRuntimeInstance",
    payload: { instanceId: "test", apiKey: "fixture-only" },
    elapsed: 75_001,
    timeout: true,
  },
  { method: "showRuntimeInstance", payload: { instanceId: "test", probe: true }, elapsed: 2_001 },
  { method: "showRuntimeInstance", payload: { instanceId: "test" }, elapsed: 2_001, timeout: true },
  { method: "updateRuntimeInstance", payload: { instanceId: "test", enabled: false }, elapsed: 20_001, timeout: true },
  { method: "updateRuntimeInstance", payload: { instanceId: "test", enabled: false }, elapsed: 2_001, error: true },
] as const;

for (const scenario of cases) {
  test(`runtime bridge ${scenario.method} ${JSON.stringify(Object.keys(scenario.payload))} ${"timeout" in scenario ? "deadline" : "error" in scenario ? "RPC error" : "delayed receipt"}`, async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-runtime-deadline-")),
      daemonId = "runtime-deadline",
      socketPath = localUserDaemonEndpoint(parent, daemonId),
      previous = { root: process.env.HARNESS_DAEMON_USER_ROOT, id: process.env.HARNESS_DAEMON_ID },
      seen: string[] = [];
    let reply!: (value: Record<string, unknown>) => void;
    const arrived = new Promise<void>((resolve) => {
      const server = net.createServer((socket) => {
        const lines = createInterface({ input: socket });
        lines.on("line", (line) => {
          const request = JSON.parse(line) as { id: number; method: string };
          if (request.method === "protocol.hello") {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, methods: ["protocol.hello", `daemon.runtimeInstance.${scenario.method === "deleteRuntimeInstance" ? "delete" : scenario.method === "showRuntimeInstance" ? "show" : scenario.method === "createRuntimeInstance" ? "create" : scenario.method === "listRuntimeInstances" ? "list" : "update"}`] } })}\n`,
            );
          } else {
            seen.push(request.method);
            reply = (value) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...value })}\n`);
            resolve();
          }
        });
      });
      t.after(async () => {
        await new Promise<void>((done) => server.close(() => done()));
        if (previous.root === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
        else process.env.HARNESS_DAEMON_USER_ROOT = previous.root;
        if (previous.id === undefined) delete process.env.HARNESS_DAEMON_ID;
        else process.env.HARNESS_DAEMON_ID = previous.id;
        rmSync(parent, { recursive: true, force: true });
      });
      mkdirSync(path.dirname(socketPath), { recursive: true });
      server.listen(socketPath);
    });
    process.env.HARNESS_DAEMON_USER_ROOT = parent;
    process.env.HARNESS_DAEMON_ID = daemonId;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = createLocalGuiServiceBridge(parent).invoke(scenario.method, scenario.payload);
    await arrived;
    t.mock.timers.tick(scenario.elapsed);
    if (!("timeout" in scenario)) {
      reply(
        "error" in scenario
          ? { error: { code: -32001, message: "fixture update rejected" } }
          : { result: { ok: true, instance: { instanceId: "test", enabled: false }, deletedInstanceId: "test" } },
      );
    }
    const receipt = (await pending) as { ok: boolean; error?: { code: string; hint: string } };
    if ("timeout" in scenario) {
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error?.code, "daemon_response_timeout");
      assert.match(receipt.error!.hint, /did not answer/);
    } else if ("error" in scenario) {
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error?.code, "json_rpc_-32001");
      assert.match(receipt.error!.hint, /fixture update rejected/);
    } else assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(seen.length, 1, "the bridge sends the operation once, including on timeout");
  });
}

test("a raised local gui.requestTimeoutMs governs the default read deadline, not the built-in 30s", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-deadline-setting-")),
    daemonId = "gui-deadline-setting",
    socketPath = localUserDaemonEndpoint(parent, daemonId),
    previous = { root: process.env.HARNESS_DAEMON_USER_ROOT, id: process.env.HARNESS_DAEMON_ID };
  const arrived = new Promise<void>((resolve) => {
    const server = net.createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "protocol.hello") {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, methods: ["protocol.hello", "daemon.gui.system.read"] } })}\n`,
          );
        } else resolve();
      });
    });
    t.after(async () => {
      await new Promise<void>((done) => server.close(() => done()));
      if (previous.root === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
      else process.env.HARNESS_DAEMON_USER_ROOT = previous.root;
      if (previous.id === undefined) delete process.env.HARNESS_DAEMON_ID;
      else process.env.HARNESS_DAEMON_ID = previous.id;
      rmSync(parent, { recursive: true, force: true });
    });
    mkdirSync(path.dirname(socketPath), { recursive: true });
    server.listen(socketPath);
  });
  // This machine's local settings raise the default answer deadline to 45 seconds.
  mkdirSync(path.join(parent, ".harness"), { recursive: true });
  writeFileSync(
    path.join(parent, ".harness/settings.local.json"),
    `${JSON.stringify({ schema: "settings-local/v1", locale: "en-US", gui: { connectTimeoutMs: 2000, requestTimeoutMs: 45_000 } })}\n`,
  );
  process.env.HARNESS_DAEMON_USER_ROOT = parent;
  process.env.HARNESS_DAEMON_ID = daemonId;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = Promise.resolve(createLocalGuiServiceBridge(parent).invoke("getSystemStatus", {}));
  await arrived;
  // The old built-in 30s deadline passes without settling the request.
  t.mock.timers.tick(30_000);
  assert.equal(
    await Promise.race([pending.then(() => true), Promise.resolve(false)]),
    false,
    "the request outlived the old 30s default",
  );
  // The configured 45s deadline is what stops it.
  t.mock.timers.tick(15_000);
  const receipt = (await pending) as { ok: boolean; error?: { code: string } };
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "daemon_response_timeout");
});

test("guiRequestTimeouts: a root without settings.local.json reads the declared defaults", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-timeouts-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(guiRequestTimeouts(root), {
    connectTimeoutMs: DEFAULT_GUI_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_GUI_REQUEST_TIMEOUT_MS,
  });
});

test("guiRequestTimeouts: a corrupt settings.local.json fails naming the file instead of falling back", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-timeouts-corrupt-")),
    file = path.join(root, ".harness/settings.local.json");
  mkdirSync(path.join(root, ".harness"), { recursive: true });
  writeFileSync(file, "{ not json\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => guiRequestTimeouts(root), /settings\.local\.json is not valid JSON/u);
  assert.throws(() => guiRequestTimeouts(root), new RegExp(file.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("guiRequestTimeouts: valid JSON that is not a local settings document fails naming the file", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-timeouts-wrongshape-")),
    file = path.join(root, ".harness/settings.local.json");
  mkdirSync(path.join(root, ".harness"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema: "settings-local/v2", gui: { connectTimeoutMs: 1 } })}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => guiRequestTimeouts(root), /settings\.local\.json/u);
  assert.throws(() => guiRequestTimeouts(root), new RegExp(file.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
