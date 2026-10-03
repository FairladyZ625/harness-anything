// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

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
