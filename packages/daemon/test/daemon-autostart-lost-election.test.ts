// harness-test-tier: fast
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  DaemonAutostartTimeoutError,
  replaceSpawnLocalDaemonForTest,
  requestLocalDaemonJsonRpcForTarget,
  type LocalDaemonTarget
} from "../src/client/local-json-rpc-client.ts";
import { encodeJsonLineFrame, type JsonRpcRequest } from "../src/index.ts";

test("autostart joins a live socket owner after its own launch loses the election", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-lost-election");
  const ownerPath = `${socketPath}.owner`;
  const launchStderrPath = `${socketPath}.launch.stderr.log`;
  let server: net.Server | undefined;
  let serverStartTimer: ReturnType<typeof setTimeout> | undefined;
  writeLiveOwner(ownerPath);
  writeFileSync(
    launchStderrPath,
    `DaemonSocketAlreadyOwnedError: daemon socket ${socketPath} is already owned by pid ${process.pid}\n`
  );
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    serverStartTimer = setTimeout(() => {
      void startJsonRpcServer(socketPath).then((started) => {
        server = started;
      });
    }, 75);
    return { pid: unusedPid(), launchStderrPath };
  });
  t.after(async () => {
    if (serverStartTimer) clearTimeout(serverStartTimer);
    restoreSpawn();
    await closeServer(server);
    rmSync(socketPath, { force: true });
    rmSync(ownerPath, { force: true });
    rmSync(launchStderrPath, { force: true });
  });

  const result = await requestLocalDaemonJsonRpcForTarget(
    makeTarget(socketPath),
    "repo.tasks.list",
    {},
    20,
    { entryPath: "/unused", timeoutMs: 1_000 }
  );

  assert.deepEqual(result, { ok: true, method: "repo.tasks.list" });
});

test("autostart reports a live socket owner as starting after its own launch loses", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-lost-election-timeout");
  const ownerPath = `${socketPath}.owner`;
  writeLiveOwner(ownerPath);
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => ({ pid: unusedPid() }));
  t.after(() => {
    restoreSpawn();
    rmSync(socketPath, { force: true });
    rmSync(ownerPath, { force: true });
  });

  await assert.rejects(
    requestLocalDaemonJsonRpcForTarget(
      makeTarget(socketPath),
      "repo.tasks.list",
      {},
      20,
      { entryPath: "/unused", timeoutMs: 140 }
    ),
    (error: unknown) => error instanceof DaemonAutostartTimeoutError
      && error.spawnedPid === process.pid
      && /live socket owner pid .* may still be starting/u.test(error.message)
      && !/DAEMON_AUTOSTART_PROCESS_EXITED/u.test(error.message)
  );
});

function writeLiveOwner(ownerPath: string): void {
  writeFileSync(ownerPath, JSON.stringify({
    schema: "daemon-socket-owner/v1",
    pid: process.pid,
    ownerToken: "winning-owner"
  }));
}

function makeTarget(socketPath: string): LocalDaemonTarget {
  return {
    repoId: "canonical",
    canonicalRoot: "/tmp/canonical",
    userRoot: "/tmp/ha-user-root",
    daemonId: "default",
    socketPath,
    legacySocketPath: `${socketPath}.legacy`,
    registered: true
  };
}

function uniqueSocketPath(prefix: string): string {
  return path.join("/tmp", `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sock`);
}

function unusedPid(): number {
  for (let candidate = 999_999; candidate >= 999_000; candidate -= 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
        return candidate;
      }
    }
  }
  throw new Error("could not find an unused high pid for the autostart fixture");
}

function startJsonRpcServer(socketPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as JsonRpcRequest;
      socket.write(encodeJsonLineFrame({
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: request.method === "protocol.hello" ? { ok: true } : { ok: true, method: request.method }
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: net.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
