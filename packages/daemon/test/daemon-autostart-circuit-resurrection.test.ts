// harness-test-tier: integration
// PLT-Honest: proves the autostart path no longer spawns sibling daemons while
// one is honestly still starting on the same socket, and that the breaker
// opens after N genuine deaths. Both behaviours are direct fixes for today's
// incident (the "复活链" that starved the user's machine).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  DaemonAutostartCircuitOpenError,
  DaemonAutostartTimeoutError,
  localDaemonRetryIntervalMs,
  replaceSpawnLocalDaemonForTest,
  requestLocalDaemonJsonRpcForTarget,
  resetDaemonAutostartCircuit,
  type LocalDaemonTarget
} from "../src/client/local-json-rpc-client.ts";
import {
  encodeJsonLineFrame,
  type JsonRpcRequest
} from "../src/index.ts";

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

async function startJsonRpcServer(socketPath: string): Promise<net.Server> {
  rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as JsonRpcRequest;
      socket.write(encodeJsonLineFrame({
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: request.method === "protocol.hello"
          ? { ok: true }
          : { ok: true, method: request.method }
      }));
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
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("a slow-cold-start daemon is not respawned while its process is alive (resurrection chain broken)", async (context) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-resurrect-slow");
  const target = makeTarget(socketPath);
  resetDaemonAutostartCircuit(socketPath);
  const servers: net.Server[] = [];
  let spawnCalls = 0;
  // Pretend the spawned daemon is a long-lived process: the current node test
  // process is alive, so the breaker treats timeouts as honest slow start and
  // records the pid for joining instead of counting a failure.
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    return { pid: process.pid };
  });
  context.after(async () => {
    restoreSpawn();
    resetDaemonAutostartCircuit(socketPath);
    await Promise.allSettled(servers.map((server) => closeServer(server)));
    rmSync(socketPath, { force: true });
  });

  // First request: autostart budget too short to see readiness, but the
  // spawned pid (us) is alive. The outcome is an honest timeout, NOT a breaker
  // failure, and the pid is recorded.
  const firstOutcome = await requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    { command: 0 },
    100,
    { entryPath: "/unused", timeoutMs: 400 }
  ).catch((error: unknown) => error instanceof DaemonAutostartTimeoutError
    ? "timeout"
    : Promise.reject(error));
  assert.equal(firstOutcome, "timeout");
  assert.equal(spawnCalls, 1, "first request must spawn exactly once");

  // Bring the daemon up now; the next request must JOIN the recorded live pid
  // (no new spawn) and succeed.
  servers.push(await startJsonRpcServer(socketPath));

  // Give the join path a generous budget so the probe can succeed.
  const secondOutcome = await requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    { command: 1 },
    100,
    { entryPath: "/unused", timeoutMs: 3_000 }
  );
  assert.deepEqual(secondOutcome, { ok: true, method: "repo.tasks.list" });
  assert.equal(spawnCalls, 1, "second request must JOIN the live pid, not spawn a sibling");
});

test("the breaker opens after N genuine spawn failures and refuses further autostart", async (context) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-resurrect-deaths");
  const target = makeTarget(socketPath);
  resetDaemonAutostartCircuit(socketPath);
  let spawnCalls = 0;
  // Every spawn produces a dead pid so the breaker counts a failure each time.
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    return { pid: 999_999 + spawnCalls }; // not alive
  });
  context.after(() => {
    restoreSpawn();
    resetDaemonAutostartCircuit(socketPath);
    rmSync(socketPath, { force: true });
  });

  const maxFailures = 3;
  const outcomes: Array<string> = [];
  for (let attempt = 0; attempt < maxFailures + 1; attempt += 1) {
    const outcome = await requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.tasks.list",
      { attempt },
      50,
      { entryPath: "/unused", timeoutMs: 120 }
    ).then(
      () => "ok",
      (error: unknown) => error instanceof DaemonAutostartCircuitOpenError
        ? "circuit-open"
        : error instanceof DaemonAutostartTimeoutError
          ? "timeout"
          : `error:${String((error as Error).message).slice(0, 40)}`
    );
    outcomes.push(outcome);
    // Allow backoff windows to elapse so the next attempt is not simply gated
    // by retryAfterMs; we want to observe the failure-limit trigger.
    if (attempt < maxFailures) {
      await new Promise((resolve) => setTimeout(resolve, localDaemonRetryIntervalMs * 2));
    }
  }

  // The first several attempts time out (dead pid, short budget). Once the
  // failure limit is reached, the breaker opens and further autostart returns
  // the honest circuit-open error instead of spawning again.
  assert.ok(outcomes.includes("circuit-open"), `expected circuit-open in outcomes: ${JSON.stringify(outcomes)}`);
  assert.ok(spawnCalls <= maxFailures + 1, `breaker must stop spawning: spawnCalls=${spawnCalls}`);
});
