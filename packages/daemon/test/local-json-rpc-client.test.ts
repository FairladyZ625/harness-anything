// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createDaemonLaunchConfiguration,
  daemonLaunchOptionsResolvedFlag,
  DaemonJsonRpcRequestTimeoutError,
  DaemonJsonRpcResponseError,
  JsonRpcLineClient,
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

test("daemon launch configuration is the canonical argv derivation for every spawner", () => {
  const canonicalRoot = path.resolve("test-fixtures", "canonical");
  const userRoot = path.resolve("test-fixtures", "ha-user-root");
  const authorityManifest = path.resolve("authority", "manifest.json");
  const authoredRoot = path.resolve(canonicalRoot, ".harness-authored");
  const execPath = path.resolve("runtime", "node");
  const entrypoint = path.resolve("runtime", "cli.js");
  const target = {
    ...makeTarget(path.resolve("test-fixtures", "ha-canonical.sock")),
    canonicalRoot,
    userRoot
  };
  const configuration = createDaemonLaunchConfiguration({
    target,
    entrypoint,
    idleExitMs: 15_000,
    execPath,
    execArgv: ["--enable-source-maps"],
    env: {
      HARNESS_AUTHORITY_MANIFEST: authorityManifest,
      HARNESS_AUTHORED_ROOT: ".harness-authored"
    },
    launchOptionsResolved: true
  });

  assert.deepEqual(configuration, {
    execPath,
    execArgv: ["--enable-source-maps"],
    entrypoint,
    args: [
      "--root", target.canonicalRoot,
      "--authored-root", authoredRoot,
      "daemon", "serve",
      "--repo", target.repoId,
      "--socket", target.socketPath,
      "--user-root", target.userRoot,
      "--idle-ms", "15000",
      "--authority-manifest", authorityManifest,
      daemonLaunchOptionsResolvedFlag
    ]
  });
});

test("legacy socket fallback diagnoses and removes an unowned empty directory occupying the socket path", async (t) => {
  if (process.platform === "win32") return;
  const primary = uniqueSocketPath("ha-daemon-missing-primary");
  const legacy = uniqueSocketPath("ha-daemon-directory-legacy");
  mkdirSync(legacy);
  t.after(() => rmSync(legacy, { recursive: true, force: true }));

  await assert.rejects(
    requestLocalDaemonJsonRpcForTarget({ ...makeTarget(primary), legacySocketPath: legacy }, "repo.daemon.logs.list", {}, 20),
    (error: unknown) => {
      assert.match(String(error), new RegExp(`path=${escapeRegExp(legacy)}`, "u"));
      assert.match(String(error), /shape=directory;owner=unowned;cleanup=removed-empty-directory;connectCode=(?:ECONNREFUSED|EINVAL|ENOTSOCK)/u);
      return true;
    }
  );
  assert.equal(existsSync(legacy), false);
});

test("legacy socket fallback preserves a directory when a live owner record exists", async (t) => {
  if (process.platform === "win32") return;
  const primary = uniqueSocketPath("ha-daemon-missing-primary-owned");
  const legacy = uniqueSocketPath("ha-daemon-directory-owned");
  mkdirSync(legacy);
  writeFileSync(`${legacy}.owner`, JSON.stringify({
    schema: "daemon-socket-owner/v1",
    pid: process.pid,
    ownerToken: "live-owner-test"
  }));
  t.after(() => {
    rmSync(`${legacy}.owner`, { force: true });
    rmSync(legacy, { recursive: true, force: true });
  });

  await assert.rejects(
    requestLocalDaemonJsonRpcForTarget({ ...makeTarget(primary), legacySocketPath: legacy }, "repo.daemon.logs.list", {}, 20),
    new RegExp(`shape=directory;owner=live-pid-${process.pid};cleanup=not-attempted;connectCode=(?:ECONNREFUSED|EINVAL|ENOTSOCK)`, "u")
  );
  assert.equal(existsSync(legacy), true);
});

test("legacy socket fallback connects to a live socket without namespace cleanup", async (t) => {
  if (process.platform === "win32") return;
  const primary = uniqueSocketPath("ha-daemon-missing-primary-live");
  const legacy = uniqueSocketPath("ha-daemon-live-legacy");
  const server = await startJsonRpcServer(legacy);
  t.after(async () => {
    await closeServer(server);
    rmSync(legacy, { force: true });
  });

  const receipt = await requestLocalDaemonJsonRpcForTarget(
    { ...makeTarget(primary), legacySocketPath: legacy },
    "repo.daemon.logs.list",
    {},
    100
  );
  assert.deepEqual(receipt, { ok: true, method: "repo.daemon.logs.list" });
  assert.equal(existsSync(legacy), true);
});

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

test("JSON-RPC requests reject within their deadline when the peer never responds", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new JsonRpcLineClient(input, output);
  const startedAt = Date.now();
  try {
    const outcome = await Promise.race([
      client.request(
        "repo.command.run",
        {},
        30
      ).then(
        () => "resolved",
        (error: unknown) => error
      ),
      delay(150).then(() => "outer-timeout")
    ]);

    assert.notEqual(outcome, "outer-timeout", "request must enforce its own deadline");
    assert.match(outcome instanceof Error ? outcome.message : "", /DAEMON_JSON_RPC_REQUEST_TIMEOUT.*repo\.command\.run.*30ms/u);
    assert.ok(Date.now() - startedAt < 150);
  } finally {
    input.destroy();
    output.destroy();
  }
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

test("autostart reports connect, launch, readiness, and request phases", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-autostart-phases");
  const target = makeTarget(socketPath);
  const phases: string[] = [];
  const timeoutResourcesBefore = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  let server: net.Server | undefined;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
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

  const result = await requestLocalDaemonJsonRpcForTarget(
    target,
    "repo.tasks.list",
    {},
    20,
    { entryPath: "/unused", timeoutMs: 1_000, onPhase: (phase) => phases.push(phase) }
  );

  assert.deepEqual(result, { ok: true, method: "repo.tasks.list" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(phases.filter((phase) => phase === "launch-start").length, 1);
  assert.deepEqual(phases.slice(-3), ["connect-start", "request-start", "request-end"]);
  assert.equal(phases.indexOf("launch-start") < phases.indexOf("ready"), true);
  const timeoutResourcesAfter = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  assert.equal(timeoutResourcesAfter <= timeoutResourcesBefore, true, "settled startup flight must cancel its deadline timer");
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

test("autostart allocates enough remaining startup budget for a slow ready-probe hello", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-slow-ready-hello");
  const target = makeTarget(socketPath);
  let helloCalls = 0;
  let server: net.Server | undefined;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    setTimeout(() => {
      void startJsonRpcServer(socketPath, {
        delayMethod: "protocol.hello",
        delayMethodMs: 1_400,
        onRequest: (method) => {
          if (method === "protocol.hello") helloCalls += 1;
        }
      }).then((started) => {
        server = started;
      });
    }, 10);
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
    200,
    { entryPath: "/unused", timeoutMs: 3_000 }
  );

  assert.deepEqual(result, { ok: true, method: "repo.tasks.list" });
  assert.equal(helloCalls, 2, "the slow ready probe should complete once before the command hello");
});

test("autostart bounds a never-responding ready probe by the total startup budget", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-ready-budget");
  const target = makeTarget(socketPath);
  let helloCalls = 0;
  let server: net.Server | undefined;
  const restoreSpawn = replaceSpawnLocalDaemonForTest(() => {
    setTimeout(() => {
      void startJsonRpcServer(socketPath, {
        ignoreMethod: "protocol.hello",
        onRequest: (method) => {
          if (method === "protocol.hello") helloCalls += 1;
        }
      }).then((started) => {
        server = started;
      });
    }, 10);
  });
  t.after(async () => {
    restoreSpawn();
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });
  const startedAt = Date.now();

  await assert.rejects(
    requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.tasks.list",
      {},
      200,
      { entryPath: "/unused", timeoutMs: 1_200 }
    ),
    (error: unknown) => !(error instanceof DaemonJsonRpcRequestTimeoutError)
      && /autostart.*1200ms/u.test(error instanceof Error ? error.message : "")
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 1_000 && elapsedMs < 2_000, `expected total-budget failure near 1200ms; saw ${elapsedMs}ms`);
  assert.ok(helloCalls >= 2, `expected multiple bounded ready probes; saw ${helloCalls}`);
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

test("autostart bounds an accepted local request when the daemon never responds", async (t) => {
  if (process.platform === "win32") return;
  const socketPath = uniqueSocketPath("ha-daemon-request-timeout");
  const target = makeTarget(socketPath);
  const server = await startJsonRpcServer(socketPath, { ignoreMethod: "repo.command.run" });
  t.after(async () => {
    await closeServer(server);
    rmSync(socketPath, { force: true });
  });
  const startedAt = Date.now();

  await assert.rejects(
    requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.command.run",
      {},
      20,
      { entryPath: "/unused", timeoutMs: 1_000, requestTimeoutMs: 40 }
    ),
    (error: unknown) => error instanceof DaemonJsonRpcRequestTimeoutError
      && error.method === "repo.command.run"
      && error.timeoutMs <= 40
  );
  assert.ok(Date.now() - startedAt < 200);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function startJsonRpcServer(socketPath: string, options: {
  readonly closeFirstConnections?: number;
  readonly delayMethod?: string;
  readonly delayMethodMs?: number;
  readonly errorMethod?: string;
  readonly ignoreMethod?: string;
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
      if (request.method === options.ignoreMethod) return;
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
      const respond = () => socket.write(encodeJsonLineFrame({
        jsonrpc: "2.0",
        id: request.id ?? null,
        result
      }));
      if (request.method === options.delayMethod) setTimeout(respond, options.delayMethodMs ?? 0);
      else respond();
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
