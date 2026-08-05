// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  DaemonAutostartTimeoutError,
  localDaemonRetryIntervalMs,
  replaceSpawnLocalDaemonForTest,
  requestLocalDaemonJsonRpcForTarget,
  type LocalDaemonTarget
} from "../src/client/local-json-rpc-client.ts";
import {
  encodeJsonLineFrame,
  type JsonObject,
  type JsonRpcRequest
} from "../src/index.ts";

const legacyAutostartBudgetMs = 6_000;
const injectedColdStartDelayMs = legacyAutostartBudgetMs + 250;
// The server starts idle, and protocol.hello deliberately does not count as a
// served request. Keep the first-request grace structurally wider than one
// client retry interval plus the hello and real-request loopback round trips.
const injectedFirstRequestGraceMs = localDaemonRetryIntervalMs * 20;

test("two commands recover through one daemon whose cold readiness exceeds the legacy budget", async (context) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-cold-recovery");
  const target = makeTarget(socketPath);
  const launches: Array<Promise<void>> = [];
  const servers: net.Server[] = [];
  let spawnCalls = 0;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    launches.push(startInjectedColdDaemon(socketPath, servers));
  });
  context.after(async () => {
    restoreSpawn();
    await Promise.allSettled(servers.map((server) => closeServer(server)));
    rmSync(socketPath, { force: true });
  });

  const outcomes: Array<JsonObject | string> = [];
  for (let command = 0; command < 2; command += 1) {
    const outcome = await requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.tasks.list",
      { command },
      100,
      { entryPath: "/unused" }
    ).catch((error: unknown) => error instanceof DaemonAutostartTimeoutError
      ? error.message
      : Promise.reject(error));
    outcomes.push(outcome);
    if (typeof outcome === "string") await launches.at(-1);
  }

  assert.deepEqual(outcomes, [
    { ok: true, method: "repo.tasks.list" },
    { ok: true, method: "repo.tasks.list" }
  ]);
  assert.equal(spawnCalls, 1);
});

function startInjectedColdDaemon(
  socketPath: string,
  servers: net.Server[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      void startJsonRpcServer(socketPath).then((server) => {
        servers.push(server);
        const idleExit = setTimeout(() => {
          void closeServer(server).then(resolve, reject);
        }, injectedFirstRequestGraceMs);
        server.on("request-served", () => clearTimeout(idleExit));
      }, reject);
    }, injectedColdStartDelayMs);
  });
}

async function startJsonRpcServer(socketPath: string): Promise<net.Server> {
  rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as JsonRpcRequest;
      const result: JsonObject = request.method === "protocol.hello"
        ? { ok: true }
        : { ok: true, method: request.method };
      socket.write(encodeJsonLineFrame({
        jsonrpc: "2.0",
        id: request.id ?? null,
        result
      }));
      if (request.method !== "protocol.hello") server.emit("request-served");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
  return path.join(
    "/tmp",
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sock`
  );
}
