// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonPidPath } from "../../daemon/src/daemon-singleton.ts";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";

const cli = path.resolve("packages/cli/src/index.ts"),
  runtimeSessionId = "runtime-wait-reconnect";

test("runtime status --wait reconnects after a protocol.hello deadline and returns the terminal dispatch", async () => {
  const fixture = await openFixtureDaemon("slow-hello");
  let allowHello = false,
    terminal = false,
    helloRequests = 0,
    statusReads = 0;
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      helloRequests += 1;
      if (allowHello) reply(socket, request.id, { ok: true });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    reply(socket, request.id, runtimeStatus(terminal));
    if (statusReads === 1) {
      terminal = true;
      socket.end();
    }
  };
  const invocation = runWait(fixture);
  try {
    await delay(30_100);
    assert.equal(invocation.closed, false, "--wait exited at the per-connection hello deadline");
    allowHello = true;
    const result = await invocation.result(10_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt.outcome, "succeeded");
    assert.equal((result.receipt.result as Record<string, unknown>).text, "settled after reconnect");
    assert.ok(helloRequests >= 3, `expected fresh hellos after timeout and stream loss, observed ${helloRequests}`);
    assert.ok(
      statusReads >= 2,
      `expected the re-subscribed reader to observe running then terminal, observed ${statusReads}`,
    );
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait returns daemon_gone with the last-known dispatch after pid and socket loss", async () => {
  const fixture = await openFixtureDaemon("daemon-gone");
  let statusReads = 0;
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    if (statusReads === 1) {
      reply(socket, request.id, runtimeStatus(false));
      return;
    }
    fixture.die();
  };
  const invocation = runWait(fixture);
  try {
    const result = await invocation.result(10_000);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.receipt.code, "daemon_gone");
    assert.equal((result.receipt.error as Record<string, unknown>).code, "daemon_gone");
    assert.deepEqual(result.receipt.lastKnownDispatch, {
      taskId: "task-runtime-wait",
      dispatchId: null,
      runtimeSessionId,
      status: "running",
      liveness: "live",
      outcome: null,
      exitCode: null,
      classification: null,
      fallbackState: null,
    });
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

interface FixtureDaemon {
  readonly root: string;
  readonly userRoot: string;
  readonly daemonId: string;
  onRequest: (socket: net.Socket, request: RpcRequest) => void;
  readonly die: () => void;
  readonly close: () => Promise<void>;
}

interface RpcRequest {
  readonly id: number;
  readonly method: string;
}

async function openFixtureDaemon(daemonId: string): Promise<FixtureDaemon> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-wait-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    socketPath = localUserDaemonEndpoint(userRoot, daemonId),
    sockets = new Set<net.Socket>();
  mkdirSync(root, { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(path.dirname(socketPath), { recursive: true });
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v1",
      repos: [{ repoId: "runtime-wait", canonicalRoot: root, state: "enabled", mode: "local" }],
    }),
  );
  writeFileSync(daemonPidPath(userRoot, daemonId), `${process.pid}\n`);
  const fixture = {
      root,
      userRoot,
      daemonId,
      onRequest: () => undefined,
      die: () => {
        rmSync(daemonPidPath(userRoot, daemonId), { force: true });
        if (server.listening) server.close();
        for (const socket of sockets) socket.destroy();
      },
      close: async () => {
        fixture.die();
        await new Promise<void>((resolve) => {
          if (!server.listening) resolve();
          else server.close(() => resolve());
        });
        rmSync(parent, { recursive: true, force: true });
      },
    } satisfies FixtureDaemon,
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += String(chunk);
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          fixture.onRequest(socket, JSON.parse(line) as RpcRequest);
        }
      });
    });
  rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return fixture;
}

function runWait(fixture: FixtureDaemon): {
  readonly closed: boolean;
  readonly result: (timeoutMs: number) => Promise<InvocationResult>;
  readonly stop: () => void;
} {
  const { HARNESS_DAEMON_ENDPOINT: _endpoint, HARNESS_DAEMON_REPO_ID: _repoId, ...baseEnv } = process.env,
    child = spawn(
      process.execPath,
      [cli, "--root", fixture.root, "--json", "runtime", "status", runtimeSessionId, "--wait", "--no-stream"],
      {
        env: {
          ...baseEnv,
          HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
          HARNESS_DAEMON_ID: fixture.daemonId,
          HARNESS_DAEMON_REPO_ID: "runtime-wait",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  let closed = false,
    stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const completion = new Promise<InvocationResult>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve({ code, receipt: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {}, stderr });
    });
  });
  return {
    get closed() {
      return closed;
    },
    result: (timeoutMs) => withTimeout(completion, child, timeoutMs),
    stop: () => {
      if (!closed) child.kill("SIGKILL");
    },
  };
}

interface InvocationResult {
  readonly code: number | null;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
}

async function withTimeout(
  completion: Promise<InvocationResult>,
  child: ChildProcess,
  timeoutMs: number,
): Promise<InvocationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`runtime status --wait did not return within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reply(socket: net.Socket, id: number, result: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function runtimeStatus(terminal: boolean): Record<string, unknown> {
  return {
    ok: true,
    status: "ready",
    session: {
      runtimeSessionId,
      providerSessionId: "provider-wait",
      instanceId: "fixture-runtime",
      installationId: "fixture-installation",
      kindId: "codex",
      definitionSnapshotRef: "fixture-definition",
      definitionSnapshot: {},
      liveness: terminal ? "exited" : "live",
      attachCapability: "supported",
      streamCursor: "stream:0",
      associations: [
        {
          taskId: "task-runtime-wait",
          executionId: "execution-runtime-wait",
          holder: null,
          lease: null,
        },
      ],
      activity: {
        lastObservedAt: "2026-08-27T00:00:00.000Z",
        outcome: terminal ? "succeeded" : null,
        exitCode: terminal ? 0 : null,
        resultRef: terminal ? "result:fixture" : null,
      },
    },
    result: terminal ? { ref: "result:fixture", text: "settled after reconnect" } : null,
    watermark: terminal ? 2 : 1,
    sourceRevision: terminal ? 2 : 1,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
