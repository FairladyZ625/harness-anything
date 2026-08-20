// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonShutdownAt } from "../src/client/local-json-rpc-client.ts";
import type { JsonRpcRequest } from "../src/protocol/json-rpc-types.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";

// The daemon stops its transport before its host, so a request still executing
// when stop() begins can land its write and never reply -- the outcome-unknown
// failure mode. The transport therefore drains in-flight requests, but under a
// deadline: an unbounded wait is what made Windows integration runs sit at the
// 900s watchdog when a client held a stream subscription open.
function drainProbeTransport(endpoint: string, handle: JsonRpcProtocolServerHandle) {
  return createUnixSocketTransportServer({
    daemonId: "drain-probe",
    socketPath: endpoint,
    createProtocolServer: () => ({ handle, close: () => {} })
  });
}
type JsonRpcProtocolServerHandle = (message: JsonRpcRequest | readonly JsonRpcRequest[]) => Promise<{ readonly jsonrpc: "2.0"; readonly id: unknown; readonly result: unknown } | undefined>;

// A local socket is a filesystem path on POSIX and a named pipe on Windows, and
// the two namespaces do not overlap: listening on a path under the temp
// directory raises EACCES on Windows. Derive the endpoint the same way the
// daemon does rather than assuming the POSIX shape.
function probeEndpoint(prefix: string): { readonly endpoint: string; readonly cleanup: () => void } {
  const token = randomBytes(6).toString("hex");
  if (process.platform === "win32") return { endpoint: `\\\\.\\pipe\\${prefix}${token}`, cleanup: () => {} };
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { endpoint: path.join(dir, "probe.sock"), cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

test("stopping the transport still delivers the reply to a request already in flight", async () => {
  const { endpoint, cleanup } = probeEndpoint("ha-transport-drain-");
  let releaseHandler: () => void = () => {};
  let handlerEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => { handlerEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const transport = drainProbeTransport(endpoint, async (message) => {
    handlerEntered();
    await blocked;
    const request = Array.isArray(message) ? message[0] : message as JsonRpcRequest;
    return { jsonrpc: "2.0", id: request.id ?? null, result: { drained: true } };
  });
  await transport.start();
  try {
    const client = net.createConnection(endpoint);
    // Resolve on the first complete frame, or on close if the reply never
    // arrives -- otherwise the assertion races the socket's read event and
    // reports an empty buffer whether or not the reply was actually sent.
    let settleReceived: (value: string) => void = () => {};
    const replied = new Promise<string>((resolve) => { settleReceived = resolve; });
    let received = "";
    client.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); if (received.includes("\n")) settleReceived(received); });
    client.on("close", () => settleReceived(received));
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "daemon.ping", params: {} })}\n`);
    await entered;
    const stopping = transport.stop();
    releaseHandler();
    await stopping;
    assert.match(await replied, /"drained":true/u, `in-flight request lost its reply across transport stop: ${JSON.stringify(received)}`);
    client.destroy();
  } finally {
    cleanup();
  }
});

test("a cooperative shutdown queues stop without waiting for the hello response", async () => {
  const { endpoint, cleanup } = probeEndpoint("ha-shutdown-queue-");
  let releaseHello: () => void = () => {};
  let helloEntered: () => void = () => {};
  let stopObserved: () => void = () => {};
  const hello = new Promise<void>((resolve) => { helloEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseHello = resolve; });
  const stopped = new Promise<void>((resolve) => { stopObserved = resolve; });
  const methods: string[] = [];
  const transport = drainProbeTransport(endpoint, async (message) => {
    const request = Array.isArray(message) ? message[0] : message as JsonRpcRequest;
    methods.push(request.method);
    if (request.method === "protocol.hello") { helloEntered(); await blocked; }
    if (request.method === "daemon.stop") stopObserved();
    return request.id === undefined ? undefined : { jsonrpc: "2.0", id: request.id, result: { ok: true } };
  });
  await transport.start();
  try {
    await requestDaemonShutdownAt(endpoint, 2_000);
    await hello;
    assert.deepEqual(methods, ["protocol.hello"]);
    releaseHello();
    await stopped;
    assert.deepEqual(methods, ["protocol.hello", "daemon.stop"]);
  } finally {
    releaseHello();
    await transport.stop();
    cleanup();
  }
});

test("transport stop stays bounded when an in-flight request never completes", async () => {
  const { endpoint, cleanup } = probeEndpoint("ha-transport-hang-");
  let handlerEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => { handlerEntered = resolve; });
  const transport = drainProbeTransport(endpoint, async () => {
    handlerEntered();
    await new Promise<void>(() => {});
    return undefined;
  });
  await transport.start();
  try {
    const client = net.createConnection(endpoint);
    client.on("data", () => {});
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "daemon.ping", params: {} })}\n`);
    await entered;
    const startedAt = Date.now();
    await transport.stop();
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 30_000, `transport stop waited ${elapsedMs}ms on a request that never completes`);
    client.destroy();
  } finally {
    cleanup();
  }
});
