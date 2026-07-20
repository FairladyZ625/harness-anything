// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNamedPipeTransportServer,
  createUnixSocketTransportServer,
  defaultNamedPipePath,
  windowsNamedPipeIntegrationEntry,
  type JsonRpcProtocolServer
} from "../src/index.ts";

const createProtocolServer = (): JsonRpcProtocolServer => ({
  handle: async () => undefined
});

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

async function connected(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}
