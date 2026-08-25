// harness-test-tier: fast
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { connectSocket, JsonRpcLineClient } from "../src/client/local-json-rpc-client.ts";

// The `--wait` reader keeps one daemon connection alive for a whole wait and issues one read round
// per poll. The line client used to attach a fresh readline interface per request and abandon it at
// the matching response id, so on that reused connection data/end/error listeners stacked one set
// per round (the 11-listener incident) and every abandoned iterator kept parsing and retaining each
// later line — unbounded memory that degraded the waiting process until its own deadlines fired.
// The locks below pin the two properties the fix bought: listener counts stay flat across rounds on
// a reused connection, and round N still resolves with round N's response after a round whose
// deadline expired and whose late response came back on the same socket.
function lineServer(handler: (request: { readonly id: number; readonly method: string; readonly params: Record<string, unknown> }, reply: (result: Record<string, unknown>) => void) => void): Promise<{ readonly socketPath: string; readonly close: () => void }> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-json-rpc-client-")), socketPath = path.join(parent, "client.sock");
  const server = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) { const request = JSON.parse(line) as { readonly id: number; readonly method: string; readonly params: Record<string, unknown> }; handler(request, (result) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)); } });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, close: () => { server.close(); rmSync(parent, { recursive: true, force: true }); } })));
}

test("a reused connection keeps its socket listener counts flat across read rounds", async () => {
  const server = await lineServer((_request, reply) => reply({ ok: true }));
  const warnings: string[] = [], onWarning = (warning: Error) => warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    const socket = await connectSocket(server.socketPath, 2_000), client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000);
      const flat = { data: socket.listenerCount("data"), end: socket.listenerCount("end"), error: socket.listenerCount("error") };
      assert.equal(flat.data >= 1 && flat.end >= 1 && flat.error >= 1, true, `hello must leave a reader attached: ${JSON.stringify(flat)}`);
      for (let round = 1; round <= 150; round += 1) {
        const result = await client.request("repo.agentRuntime.sessions.read", { round }, 5_000);
        assert.deepEqual(result, { ok: true }, `round ${round} must resolve with its own response`);
        assert.deepEqual({ data: socket.listenerCount("data"), end: socket.listenerCount("end"), error: socket.listenerCount("error") }, flat, `listener counts must not grow with read rounds (after round ${round})`);
      }
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual({ data: socket.listenerCount("data"), end: socket.listenerCount("end"), error: socket.listenerCount("error") }, { data: 0, end: flat.end - 1, error: flat.error - 1 }, "close must detach the reader's listener set");
    } finally { clientClose(client); }
  } finally { process.off("warning", onWarning); server.close(); }
  assert.equal(warnings.includes("MaxListenersExceededWarning"), false, `no listener ceiling may be crossed: ${warnings.join(", ")}`);
});

test("a round whose deadline expired does not poison the next round on the same connection", async () => {
  const server = await lineServer((request, reply) => setTimeout(() => reply({ ok: true, echo: request.method }), request.method === "stalled" ? 120 : 1));
  try {
    const socket = await connectSocket(server.socketPath, 2_000), client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000);
      await assert.rejects(() => client.request("stalled", {}, 25), (error: unknown) => (error as { readonly code?: string }).code === "daemon_response_timeout");
      await new Promise((resolve) => setTimeout(resolve, 200)); // the late response lands and must be dropped
      const next = await client.request("prompt", { round: 2 }, 5_000);
      assert.deepEqual(next, { ok: true, echo: "prompt" }, "the next round must resolve with its own response, not the stale one");
    } finally { clientClose(client); }
  } finally { server.close(); }
});

test("a daemon that closes mid-exchange rejects the pending request instead of hanging it", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-json-rpc-client-")), socketPath = path.join(parent, "torn.sock");
  const server = net.createServer((socket) => {
    let seenHello = false;
    socket.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) { const request = JSON.parse(line) as { readonly id: number; readonly method: string }; if (request.method === "protocol.hello") { seenHello = true; socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`); } } if (seenHello) setTimeout(() => socket.destroy(), 20); });
    socket.on("error", () => undefined);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const socket = await connectSocket(socketPath, 2_000), client = new JsonRpcLineClient(socket, socket);
    try {
      await client.request("protocol.hello", { protocolVersion: { major: 1, minor: 0 } }, 5_000);
      await assert.rejects(() => client.request("repo.agentRuntime.sessions.read", {}, 5_000), /daemon closed before JSON-RPC response/u);
      await assert.rejects(() => client.request("repo.agentRuntime.sessions.read", {}, 5_000), /daemon closed before JSON-RPC response/u);
    } finally { clientClose(client); }
  } finally { server.close(); rmSync(parent, { recursive: true, force: true }); }
});

function clientClose(client: { readonly close: () => void }): void { try { client.close(); } catch { /* an already-torn socket may reject the final end */ } }
