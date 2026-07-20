// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAcceptedConnectionEvidence,
  createNamedPipeTransportServer,
  createUnixSocketTransportServer,
  defaultNamedPipePath,
  windowsNamedPipeIntegrationEntry,
  type JsonRpcProtocolServer
} from "../src/index.ts";

const createProtocolServer = (): JsonRpcProtocolServer => ({
  handle: async () => undefined
});
const largeReceiptPayload = "r".repeat(4 * 1024 * 1024);

test("unix socket transport stop closes an accepted idle connection without waiting for its owner", async () => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-unix-stop-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-stop-test",
    socketPath,
    createProtocolServer
  });
  await transport.start();
  const socket = net.createConnection(socketPath);
  await connected(socket);
  const clientClosed = closed(socket);

  const stopped = transport.stop();
  const settled = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
  ]);
  if (!settled) socket.destroy();
  await stopped;
  await clientClosed;
  assert.equal(settled, true);
  assert.equal(socket.destroyed, true);
});

test("unix socket transport stop flushes a buffered receipt before closing", async () => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-unix-flush-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  await assertBufferedReceiptFlushes((createProtocolServer) => createUnixSocketTransportServer({
    daemonId: "daemon-flush-test",
    socketPath,
    acceptedConnectionEvidenceAdapter: immediateEvidenceAdapter("unix-socket"),
    createProtocolServer
  }));
});

test("named pipe transport stop closes an accepted idle connection on Windows", {
  skip: process.platform !== "win32" ? windowsNamedPipeIntegrationEntry().reason : false
}, async () => {
  const pipePath = `${defaultNamedPipePath(`transport-stop-${process.pid}`)}-${Date.now()}`;
  const transport = createNamedPipeTransportServer({
    daemonId: "daemon-stop-test",
    pipePath,
    createProtocolServer
  });
  await transport.start();
  const socket = net.createConnection(pipePath);
  await connected(socket);
  const clientClosed = closed(socket);

  const stopped = transport.stop();
  const settled = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
  ]);
  if (!settled) socket.destroy();
  await stopped;
  await clientClosed;
  assert.equal(settled, true);
  assert.equal(socket.destroyed, true);
});

test("named pipe transport stop flushes a buffered receipt before closing on Windows", {
  skip: process.platform !== "win32" ? windowsNamedPipeIntegrationEntry().reason : false
}, async () => {
  const pipePath = `${defaultNamedPipePath(`transport-flush-${process.pid}`)}-${Date.now()}`;
  await assertBufferedReceiptFlushes((createProtocolServer) => createNamedPipeTransportServer({
    daemonId: "daemon-flush-test",
    pipePath,
    acceptedConnectionEvidenceAdapter: immediateEvidenceAdapter("named-pipe"),
    createProtocolServer
  }));
});

async function assertBufferedReceiptFlushes(createTransport: (createProtocolServer: () => JsonRpcProtocolServer) => {
  readonly endpoint: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}): Promise<void> {
  let markResponseHandled: (() => void) | undefined;
  const responseHandled = new Promise<void>((resolve) => { markResponseHandled = resolve; });
  const transport = createTransport(() => ({
    handle: async () => {
      markResponseHandled?.();
      return {
        jsonrpc: "2.0",
        id: 1,
        result: { receipt: largeReceiptPayload }
      };
    }
  }));
  await transport.start();
  const socket = net.createConnection(transport.endpoint);
  await connected(socket);
  const received = receiveUntilEnd(socket);
  socket.pause();
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fixture.slow", params: {} })}\n`);
  await responseHandled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopped = transport.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.resume();

  const frame = await received;
  await stopped;
  const response = JSON.parse(frame.trim()) as {
    readonly result?: { readonly receipt?: unknown };
  };
  assert.equal(response.result?.receipt, largeReceiptPayload);
}

async function connected(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}

function receiveUntilEnd(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

function immediateEvidenceAdapter(transportKind: "unix-socket" | "named-pipe") {
  return {
    observeAcceptedConnection: async (input: {
      readonly connectionId: string;
      readonly connectionGeneration: number;
      readonly daemonInstanceId: string;
      readonly compatibilityBoundary?: { readonly ownerUid: number; readonly source: "unix-socket-filesystem-owner-boundary" };
    }) => createAcceptedConnectionEvidence({
      ...input,
      transportKind,
      peerCredential: {
        available: false,
        code: "observation_failed",
        source: "os-peer-credential-adapter"
      },
      serverRandom: Buffer.alloc(32, 7)
    })
  };
}
