// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createUnixSocketTransportServer,
  type JsonRpcProtocolServer
} from "../src/index.ts";

const createProtocolServer = (): JsonRpcProtocolServer => ({
  handle: async () => undefined
});

test("unix socket transport removes an unowned empty endpoint directory with the shared namespace diagnosis", async (t) => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-endpoint-directory-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  mkdirSync(socketPath);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-test",
    socketPath,
    createProtocolServer
  });

  await assert.rejects(
    transport.start(),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /^Error: DAEMON_SOCKET_NAMESPACE_INVALID:/u);
      assert.equal(
        message.includes(`path=${socketPath};shape=directory;owner=unowned;cleanup=removed-empty-directory;`),
        true,
        message
      );
      assert.match(message, /connectCode=(?:ERR_FS_EISDIR|EISDIR)$/u);
      return true;
    }
  );
  assert.equal(lstatSync(socketPath, { throwIfNoEntry: false }), undefined);
});

test("unix socket transport preserves an endpoint directory with a live owner", async (t) => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-owned-endpoint-directory-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  mkdirSync(socketPath);
  writeFileSync(`${socketPath}.owner`, JSON.stringify({
    schema: "daemon-socket-owner/v1",
    pid: process.pid,
    ownerToken: "live-owner-test"
  }));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-test",
    socketPath,
    createProtocolServer
  });

  await assert.rejects(
    transport.start(),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /^Error: DAEMON_SOCKET_NAMESPACE_INVALID:/u);
      assert.equal(
        message.includes(`path=${socketPath};shape=directory;owner=live-pid-${process.pid};cleanup=not-attempted;`),
        true,
        message
      );
      assert.match(message, /connectCode=(?:ERR_FS_EISDIR|EISDIR)$/u);
      return true;
    }
  );
  assert.equal(lstatSync(socketPath).isDirectory(), true);
});

test("unix socket transport preserves an unowned non-empty endpoint directory", async (t) => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-non-empty-endpoint-directory-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  const occupant = path.join(socketPath, "unowned-content.txt");
  mkdirSync(socketPath);
  writeFileSync(occupant, "preserve me\n", "utf8");
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-test",
    socketPath,
    createProtocolServer
  });

  await assert.rejects(
    transport.start(),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /^Error: DAEMON_SOCKET_NAMESPACE_INVALID:/u);
      assert.equal(
        message.includes(`path=${socketPath};shape=directory;owner=unowned;cleanup=preserved-non-empty-directory;`),
        true,
        message
      );
      assert.match(message, /connectCode=(?:ERR_FS_EISDIR|EISDIR)$/u);
      return true;
    }
  );
  assert.equal(lstatSync(occupant).isFile(), true);
});

test("unix socket transport replaces a stale socket and listens on the same endpoint", async (t) => {
  if (process.platform === "win32") return;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-stale-socket-"));
  const socketPath = path.join(tempDir, "daemon.sock");
  const staleOwner = spawnSync(process.execPath, [
    "-e",
    "const net = require('node:net'); net.createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));",
    socketPath
  ], { encoding: "utf8" });
  assert.equal(staleOwner.signal, "SIGKILL", staleOwner.stderr);
  assert.equal(lstatSync(socketPath).isSocket(), true);

  const transport = createUnixSocketTransportServer({
    daemonId: "daemon-test",
    socketPath,
    createProtocolServer
  });
  let started = false;
  t.after(async () => {
    if (started) await transport.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  await transport.start();
  started = true;
  assert.equal(lstatSync(socketPath).isSocket(), true);
});
