// harness-test-tier: fast
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  DaemonJsonRpcResponseError,
  replaceSpawnLocalDaemonForTest,
  requestLocalDaemonJsonRpcForTarget,
  type LocalDaemonTarget
} from "../src/client/local-json-rpc-client.ts";
import {
  createJsonLineFrameReader,
  encodeJsonLineFrame,
  type JsonObject,
  type JsonRpcRequest
} from "../src/index.ts";

test("JSON line frames preserve UTF-8 when a multibyte character spans chunks", () => {
  const request = {
    jsonrpc: "2.0",
    id: "utf8-split",
    method: "repo.doc.sync.submit",
    params: { payload: { body: "正文内容" } }
  } satisfies JsonRpcRequest;
  const encoded = Buffer.from(encodeJsonLineFrame(request), "utf8");
  const firstCharacter = encoded.indexOf(Buffer.from("正", "utf8"));
  assert.notEqual(firstCharacter, -1);

  const reader = createJsonLineFrameReader();
  const first = reader.push(encoded.subarray(0, firstCharacter + 1));
  const second = reader.push(encoded.subarray(firstCharacter + 1));

  assert.deepEqual(first, { frames: [] });
  assert.deepEqual(second, { frames: [request] });
});

test("autostart coalesces concurrent requests to one spawn per socket path", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-singleflight");
  const target = makeTarget(socketPath);
  let spawnCalls = 0;
  let server: net.Server | undefined;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    setTimeout(() => {
      void startJsonRpcServer(socketPath).then((started) => {
        server = started;
      });
    }, 50);
  });
  t.after(async () => {
    restoreSpawn();
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });

  const requests = Array.from({ length: 32 }, (_, index) =>
    requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.tasks.list",
      { request: index },
      20,
      { entryPath: "/unused", timeoutMs: 1_000 }
    )
  );

  const results = await Promise.all(requests);

  assert.equal(spawnCalls, 1);
  assert.equal(results.length, 32);
  assert.deepEqual(results[0], { ok: true, method: "repo.tasks.list" });
});

test("autostart clears failed single-flight so a later request can spawn again", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-singleflight-retry");
  const target = makeTarget(socketPath);
  let spawnCalls = 0;
  let server: net.Server | undefined;
  let shouldStartServer = false;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    if (!shouldStartServer) return;
    setTimeout(() => {
      void startJsonRpcServer(socketPath).then((started) => {
        server = started;
      });
    }, 20);
  });
  t.after(async () => {
    restoreSpawn();
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });

  const failedRequests = Array.from({ length: 8 }, () =>
    requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.tasks.list",
      {},
      20,
      { entryPath: "/unused", timeoutMs: 180 }
    )
  );

  await Promise.all(failedRequests.map((request) => assert.rejects(request)));
  assert.equal(spawnCalls, 1);

  shouldStartServer = true;
  const result = await requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    {},
    20,
    { entryPath: "/unused", timeoutMs: 1_000 }
  );

  assert.equal(spawnCalls, 2);
  assert.deepEqual(result, { ok: true, method: "repo.tasks.list" });
});

test("autostart keeps the shared spawn alive when an early caller times out", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-singleflight-deadline");
  const target = makeTarget(socketPath);
  let spawnCalls = 0;
  let server: net.Server | undefined;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    setTimeout(() => {
      void startJsonRpcServer(socketPath).then((started) => {
        server = started;
      });
    }, 220);
  });
  t.after(async () => {
    restoreSpawn();
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });

  const shortDeadlineRequest = requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    {},
    20,
    { entryPath: "/unused", timeoutMs: 90 }
  );
  await delay(10);
  const longDeadlineRequest = requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    {},
    20,
    { entryPath: "/unused", timeoutMs: 1_000 }
  );

  await assert.rejects(shortDeadlineRequest);
  assert.deepEqual(await longDeadlineRequest, { ok: true, method: "repo.tasks.list" });
  assert.equal(spawnCalls, 1);
});

test("autostart retries when the socket accepts before JSON-RPC is ready", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-singleflight-handshake");
  const target = makeTarget(socketPath);
  let spawnCalls = 0;
  let server: net.Server | undefined;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    spawnCalls += 1;
    setTimeout(() => {
      void startJsonRpcServer(socketPath, { closeFirstConnections: 2 }).then((started) => {
        server = started;
      });
    }, 30);
  });
  t.after(async () => {
    restoreSpawn();
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });

  const result = await requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    {},
    20,
    { entryPath: "/unused", timeoutMs: 1_000 }
  );

  assert.equal(spawnCalls, 1);
  assert.deepEqual(result, { ok: true, method: "repo.tasks.list" });
});

test("autostart surfaces a daemon JSON-RPC error once without retrying it as a disconnect", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-response-error");
  const target = makeTarget(socketPath);
  let failedMethodCalls = 0;
  const server = await startJsonRpcServer(socketPath, {
    errorMethod: "repo.task.claim",
    onRequest: (method) => {
      if (method === "repo.task.claim") failedMethodCalls += 1;
    }
  });
  t.after(async () => {
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });

  await assert.rejects(
    requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.task.claim",
      {},
      20,
      { entryPath: "/unused", timeoutMs: 1_000 }
    ),
    (error: unknown) => {
      assert.equal(error instanceof DaemonJsonRpcResponseError, true);
      assert.equal((error as DaemonJsonRpcResponseError).code, -32603);
      assert.equal((error as Error).message, "execution lease write exploded");
      return true;
    }
  );
  assert.equal(failedMethodCalls, 1);
});

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

async function startJsonRpcServer(socketPath: string, options: {
  readonly closeFirstConnections?: number;
  readonly errorMethod?: string;
  readonly onRequest?: (method: string) => void;
} = {}): Promise<net.Server> {
  rmSync(socketPath, { force: true });
  let closeConnections = options.closeFirstConnections ?? 0;
  const server = net.createServer((socket) => {
    if (closeConnections > 0) {
      closeConnections -= 1;
      socket.destroy();
      return;
    }
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as JsonRpcRequest;
      options.onRequest?.(request.method);
      if (request.method === options.errorMethod) {
        socket.write(encodeJsonLineFrame({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32603, message: "execution lease write exploded" }
        }));
        return;
      }
      const result: JsonObject = request.method === "protocol.hello"
        ? { ok: true }
        : { ok: true, method: request.method };
      socket.write(encodeJsonLineFrame({
        jsonrpc: "2.0",
        id: request.id ?? null,
        result
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

function closeServer(server: net.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
