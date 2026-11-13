// harness-test-tier: fast
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { registerDaemonConnection } from "@harness-anything/kernel";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "../../daemon/test/repo-settings.fixture.ts";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

// The incident: a GUI bundle built before 9737f8f784 reads an Agent catalog from a daemon
// that already carries hostAccess/hostAccessSource. The client-inbound read must deliver the
// page instead of failing it, and the dev log records the ignored additive field once.
const futureCatalog = {
  schema: "agent-entity-catalog/v1",
  ok: true,
  agents: [
    {
      id: "terra",
      name: "Terra",
      runtimes: [{ type: "codex" }],
      instance: null,
      permissionMode: null,
      mcpPolicy: null,
      hostAccess: "operator",
      hostAccessSource: "default",
      role: "worker",
      layer: "user",
      retirement: null,
      futureOptionalField: true,
    },
  ],
};

test("a GUI read survives additive daemon fields and keeps the unknown field out of the failure path", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-agent-compat-")),
    socketPath = localUserDaemonEndpoint(parent, "agent-compat"),
    previous = {
      root: process.env.HARNESS_DAEMON_USER_ROOT,
      id: process.env.HARNESS_DAEMON_ID,
      endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
    },
    server = net.createServer((socket) => {
      createInterface({ input: socket }).on("line", (line) => {
        const request = JSON.parse(line) as { readonly id: number; readonly method: string },
          result = request.method === "protocol.hello" ? fixtureDaemonHello() : futureCatalog;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      });
    }),
    warn = t.mock.method(console, "warn", () => undefined);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  registerDaemonConnection({ id: "center", endpoint: "tcp://127.0.0.1:19912", userRoot: parent });
  registerDaemonRepo({ repoId: "proxy-repo", mode: "remote-proxy", connectionId: "center", userRoot: parent });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.HARNESS_DAEMON_USER_ROOT = parent;
  process.env.HARNESS_DAEMON_ID = "agent-compat";
  process.env.HARNESS_DAEMON_ENDPOINT = socketPath;
  try {
    const bridge = createLocalGuiServiceBridge(),
      first = (await bridge.invoke("listAgents", { repoId: "proxy-repo" })) as { readonly ok: boolean },
      second = (await bridge.invoke("listAgents", { repoId: "proxy-repo" })) as { readonly ok: boolean };

    assert.equal(first.ok, true, `an additive daemon field must not fail the read view: ${JSON.stringify(first)}`);
    assert.equal(second.ok, true, "a poll after the first success stays green");
    assert.equal(warn.mock.calls.length, 1, "the ignored additive field is logged once per process");
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /futureOptionalField/u);
    assert.doesNotMatch(String(warn.mock.calls[0]?.arguments[0]), /Local daemon request failed/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous.root === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previous.root;
    if (previous.id === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previous.id;
    if (previous.endpoint === undefined) delete process.env.HARNESS_DAEMON_ENDPOINT;
    else process.env.HARNESS_DAEMON_ENDPOINT = previous.endpoint;
    rmSync(parent, { recursive: true, force: true });
  }
});
