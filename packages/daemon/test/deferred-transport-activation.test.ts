// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  createUnixSocketTransportServer,
  currentDaemonProtocolVersion,
  encodeJsonLineFrame,
  type JsonRpcProtocolServer,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "../src/index.ts";

test("unix socket can bind early without dispatching before service activation", async (t) => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-deferred-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-deferred",
    socketPath,
    deferConnectionsUntilActivated: true,
    createProtocolServer: () => protocolServer()
  });
  t.after(() => transport.stop());
  await transport.start();

  const socket = net.createConnection(socketPath);
  t.after(() => socket.destroy());
  const lines = createInterface({ input: socket });
  const response = new Promise<JsonRpcResponse>((resolve) => {
    lines.once("line", (line) => resolve(JSON.parse(line) as JsonRpcResponse));
  });
  socket.write(encodeJsonLineFrame({
    jsonrpc: "2.0",
    id: "deferred-hello",
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion }
  }));
  assert.equal(
    await Promise.race([
      response.then(() => "received"),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50))
    ]),
    "pending"
  );

  await transport.activate();
  assert.equal((await response).result?.ok, true);
});

function protocolServer(): JsonRpcProtocolServer {
  return {
    handle: async (request: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        ok: true,
        schema: "command-receipt/v2",
        command: request.method,
        action: request.method,
        summary: "ready",
        meta: {
          generatedAt: "2026-07-24T00:00:00.000Z",
          compatibility: { legacyReceipt: "CommandReceipt/v1" }
        }
      }
    })
  };
}
