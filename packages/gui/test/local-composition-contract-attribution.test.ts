// harness-test-tier: fast
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

test("a client-side contract rejection is not reported as a daemon request failure", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-contract-attribution-")),
    socketPath = localUserDaemonEndpoint(parent, "contract-attribution"),
    previousEndpoint = process.env.HARNESS_DAEMON_ENDPOINT,
    previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousDaemonId = process.env.HARNESS_DAEMON_ID,
    // Shape the current GUI bundle cannot validate (daemon is missing), so parse throws after
    // the transport succeeded. That failure belongs to the client contract, not the daemon.
    invalidSystemStatus = {
      schema: "gui-system-status/v1",
      ok: true,
      observedAt: "2026-11-08T00:00:00.000Z",
      repos: [],
    },
    server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { readonly id: number; readonly method: string },
            result = request.method === "protocol.hello" ? fixtureDaemonHello() : invalidSystemStatus;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
  mkdirSync(path.dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.HARNESS_DAEMON_ENDPOINT = socketPath;
  process.env.HARNESS_DAEMON_USER_ROOT = parent;
  process.env.HARNESS_DAEMON_ID = "contract-attribution";
  try {
    const result = (await createLocalGuiServiceBridge().invoke("getSystemStatus", {})) as {
      readonly ok: boolean;
      readonly error: { readonly code: string; readonly hint: string };
    };

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "gui_result_contract_mismatch");
    assert.doesNotMatch(result.error.hint, /^Local daemon request failed/u);
    assert.match(result.error.hint, /GUI/u);
    assert.match(result.error.hint, /npm run build -w @harness-anything\/gui/u);
    assert.match(result.error.hint, /restart Electron/iu);
  } finally {
    if (previousEndpoint === undefined) delete process.env.HARNESS_DAEMON_ENDPOINT;
    else process.env.HARNESS_DAEMON_ENDPOINT = previousEndpoint;
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    server.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
