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
import { writeDaemonStoppedMarker } from "../../daemon/src/client/daemon-autostart.ts";

const cli = path.resolve("packages/cli/src/index.ts"),
  runtimeSessionId = "runtime-wait-reconnect";

test("runtime status --wait renders the daemon verdict while the attached stream shows activity", async () => {
  const fixture = await openFixtureDaemon("stream-terminal");
  let statusReads = 0,
    awaitRequests = 0,
    attachSocket: net.Socket | undefined;
  const pendingAwait: { socket: net.Socket; id: number }[] = [];
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.attach") {
      attachSocket = socket;
      reply(socket, request.id, {
        ok: true,
        status: "attached",
        runtimeSessionId,
        cursor: "stream:0",
        events: [],
      });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      awaitRequests += 1;
      pendingAwait.push({ socket, id: request.id });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture, ["runtime", "status", runtimeSessionId, "--wait"], false);
  try {
    for (const deadline = Date.now() + 4_000; (!attachSocket || pendingAwait.length === 0) && Date.now() < deadline; )
      await delay(20);
    assert.ok(attachSocket, "the runtime stream must attach");
    assert.equal(pendingAwait.length, 1, "the daemon-side await must be parked");
    await delay(1_200);
    assert.equal(statusReads, 1, "a parked await must not perform periodic status reads");
    attachSocket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "repo.agentRuntime.attach.frame",
        params: {
          schema: "agent-runtime-attach-event/v1",
          type: "exit",
          runtimeSessionId,
          cursor: "stream:1",
          occurredAt: "2026-08-28T00:00:00.000Z",
          outcome: "succeeded",
        },
      })}\n`,
    );
    for (const pending of pendingAwait) reply(pending.socket, pending.id, awaitReceipt());
    const result = await invocation.result(2_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "settled after reconnect");
    assert.equal(awaitRequests, 1);
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait keeps one daemon await across an attached stream gap", async () => {
  const fixture = await openFixtureDaemon("stream-gap");
  let statusReads = 0,
    awaitRequests = 0;
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.attach") {
      reply(socket, request.id, {
        ok: true,
        status: "gap",
        runtimeSessionId,
        cursor: "stream:40",
        events: [
          {
            schema: "agent-runtime-attach-event/v1",
            type: "gap",
            runtimeSessionId,
            cursor: "stream:40",
            occurredAt: "2026-08-28T00:00:00.000Z",
            required: "snapshot",
          },
        ],
      });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      awaitRequests += 1;
      reply(socket, request.id, awaitReceipt());
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture, ["runtime", "status", runtimeSessionId, "--wait"], false);
  try {
    const result = await invocation.result(4_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "settled after reconnect");
    assert.equal(statusReads, 1, "a stream gap must not trigger extra status reads");
    assert.equal(awaitRequests, 1);
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait keeps the daemon wait when the attached stream is lost", async () => {
  const fixture = await openFixtureDaemon("stream-lost");
  let statusReads = 0,
    awaitRequests = 0,
    attachAttempts = 0;
  const pendingAwait: { socket: net.Socket; id: number }[] = [];
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.attach") {
      attachAttempts += 1;
      reply(socket, request.id, {
        ok: true,
        status: "attached",
        runtimeSessionId,
        cursor: "stream:0",
        events: [],
      });
      setTimeout(() => socket.destroy(), 20);
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      awaitRequests += 1;
      pendingAwait.push({ socket, id: request.id });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture, ["runtime", "status", runtimeSessionId, "--wait"], false);
  try {
    for (const deadline = Date.now() + 8_000; attachAttempts < 2 && Date.now() < deadline; ) await delay(50);
    assert.ok(attachAttempts >= 2, `expected stream reconnect attempts, observed ${attachAttempts}`);
    assert.equal(pendingAwait.length, 1, "the daemon-side await must stay parked through stream loss");
    for (const pending of pendingAwait) reply(pending.socket, pending.id, awaitReceipt());
    const result = await invocation.result(2_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "settled after reconnect");
    assert.equal(statusReads, 1);
    assert.equal(awaitRequests, 1, "stream loss must not reissue the daemon await");
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait reconnects the await after the daemon restarts", async () => {
  const fixture = await openFixtureDaemon("daemon-restart");
  let statusReads = 0,
    awaitRequests = 0;
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      awaitRequests += 1;
      if (awaitRequests === 1) {
        void fixture.restart();
        return;
      }
      reply(socket, request.id, awaitReceipt());
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture);
  try {
    const result = await invocation.result(12_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt.outcome, "succeeded");
    assert.equal(awaitRequests, 2, "the idempotent await must be reissued on the new daemon");
    assert.equal(statusReads, 1, "the probe read happens once");
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
    if (request.method === "repo.agentRuntime.sessions.await") {
      fixture.die();
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    statusReads += 1;
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture);
  try {
    const result = await invocation.result(20_000);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.receipt.code, "daemon_gone");
    assert.equal((result.receipt.error as Record<string, unknown>).code, "daemon_gone");
    assert.equal(statusReads, 1, "the probe read happens once before the await");
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

test("runtime status --wait bridges a daemon_stopping handoff whose successor pid is already written", async () => {
  // The pid baseline must come from before the request: a build-superseded handoff answers a
  // parked request and its successor rewrites the pid file within milliseconds, so a baseline read
  // after the answer can already name the new generation and the wait would never see a change.
  const fixture = await openFixtureDaemon("stopping-handoff");
  let awaitRequests = 0;
  writeFileSync(daemonPidPath(fixture.userRoot, fixture.daemonId), "424242\n");
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      awaitRequests += 1;
      if (awaitRequests === 1) {
        // The refused wait lands after the successor already wrote its pid: answer, then rebind.
        writeFileSync(daemonPidPath(fixture.userRoot, fixture.daemonId), "424243\n");
        reply(socket, request.id, { ok: false, code: "daemon_stopping", error: { code: "daemon_stopping" } });
        void fixture.restart();
        return;
      }
      reply(socket, request.id, awaitReceipt());
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture);
  try {
    const result = await invocation.result(12_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt.outcome, "succeeded");
    assert.equal(awaitRequests, 2, "the daemon_stopping bridge must reissue the idempotent await");
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait reports an operator stop honestly instead of burning its reconnect budget", async () => {
  const fixture = await openFixtureDaemon("operator-stop");
  const pendingAwait: { socket: net.Socket; id: number }[] = [];
  let awaitRequests = 0;
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      awaitRequests += 1;
      pendingAwait.push({ socket, id: request.id });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture);
  try {
    for (const deadline = Date.now() + 4_000; pendingAwait.length === 0 && Date.now() < deadline; ) await delay(20);
    assert.equal(pendingAwait.length, 1, "the daemon-side await must be parked");
    // The operator's stop writes the marker before the daemon drains, so the wait can tell a stop
    // apart from a restart handoff: it reports the stop and never tries to reconnect.
    writeDaemonStoppedMarker(fixture.userRoot, fixture.daemonId);
    fixture.die();
    const result = await invocation.result(4_000);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.receipt.code, "daemon_stopped_by_operator");
    assert.match(String((result.receipt.error as Record<string, unknown>).hint), /stopped by the operator/u);
    assert.equal(awaitRequests, 1);
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait surfaces the daemon's settlement failure verdict", async () => {
  const fixture = await openFixtureDaemon("settlement-outcome");
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      reply(
        socket,
        request.id,
        awaitReceipt({
          outcome: "unknown",
          exitCode: 1,
          code: "runtime_settlement_failed",
          reason: "injected failure: runtime_lease_release_failed",
          resultText: "injected failure: runtime_lease_release_failed",
        }),
      );
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture);
  try {
    const result = await invocation.result(4_000);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.receipt.code, "runtime_settlement_failed");
    assert.equal(result.receipt.outcome, "unknown");
    assert.match(String(result.receipt.reason), /runtime_lease_release_failed/u);
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("runtime status --wait does not infer settlement failure from an unknown outcome's text", async () => {
  const fixture = await openFixtureDaemon("unknown-outcome");
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    if (request.method === "repo.agentRuntime.sessions.await") {
      reply(
        socket,
        request.id,
        awaitReceipt({
          outcome: "unknown",
          exitCode: 1,
          code: "provider_exit",
          reason: "Runtime terminal settlement failed (provider-authored diagnostic)",
          resultText: "Runtime terminal settlement failed (provider-authored diagnostic)",
        }),
      );
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.read");
    reply(socket, request.id, runtimeStatus(false));
  };
  const invocation = runWait(fixture);
  try {
    const result = await invocation.result(4_000);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.receipt.code, "provider_exit");
    assert.equal(result.receipt.outcome, "unknown");
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("multi-target runtime status --wait issues one daemon await and renders the settled split", async () => {
  const fixture = await openFixtureDaemon("multi-target");
  let helloRequests = 0,
    awaitRequests = 0;
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      helloRequests += 1;
      reply(socket, request.id, { ok: true });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.await");
    awaitRequests += 1;
    assert.deepEqual(request.params.payload.runtimeSessionIds, [runtimeSessionId, "runtime-wait-other"]);
    reply(
      socket,
      request.id,
      awaitReceipt({
        inFlight: ["runtime-wait-other"],
        summary: `runtime-status: ${runtimeSessionId} settled succeeded; 1 still in flight`,
      }),
    );
  };
  const invocation = runWait(fixture, [
    "runtime",
    "status",
    runtimeSessionId,
    "runtime-wait-other",
    "--wait",
    "--no-stream",
  ]);
  try {
    const result = await invocation.result(4_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt.outcome, "succeeded");
    assert.equal(result.receipt.mode, "any");
    assert.deepEqual(
      (result.receipt.sessions as Array<Record<string, unknown>>).map((row) => row.runtimeSessionId),
      [runtimeSessionId],
    );
    assert.deepEqual(
      (result.receipt.inFlight as Array<Record<string, unknown>>).map((row) => row.runtimeSessionId),
      ["runtime-wait-other"],
    );
    assert.equal(awaitRequests, 1, "one daemon await covers every target");
    assert.equal(helloRequests, 1, "the wait rides one connection");
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("task dispatch wait rides one sessions.await request", async () => {
  const fixture = await openFixtureDaemon("task-await"),
    taskId = "task-runtime-wait";
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.await");
    assert.deepEqual(request.params.payload.taskIds, [taskId]);
    reply(socket, request.id, {
      schema: "command-receipt/v2",
      ok: true,
      status: "ready",
      command: "runtime-status",
      mode: "all",
      taskIds: [taskId],
      dispatches: [
        {
          dispatchId: "dispatch-runtime-wait",
          status: "succeeded",
          outcome: "succeeded",
          exitCode: 0,
          fallbackState: null,
          nextDispatchId: null,
        },
      ],
      outcome: "succeeded",
      exitCode: 0,
      summary: `runtime-status task ${taskId}: 1 dispatch succeeded`,
    });
  };
  const invocation = runWait(fixture, ["runtime", "status", "--task", taskId, "--wait", "--no-stream"]);
  try {
    const result = await invocation.result(4_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt.outcome, "succeeded");
    assert.equal(result.receipt.exitCode, 0);
    assert.deepEqual(
      (result.receipt.dispatches as Array<Record<string, unknown>>).map((row) => row.dispatchId),
      ["dispatch-runtime-wait"],
    );
  } finally {
    invocation.stop();
    await fixture.close();
  }
});

test("task dispatch wait classifies an unreachable daemon as daemon_gone", async () => {
  const fixture = await openFixtureDaemon("task-daemon-gone"),
    taskId = "task-runtime-wait";
  fixture.onRequest = (socket, request) => {
    if (request.method === "protocol.hello") {
      reply(socket, request.id, { ok: true });
      return;
    }
    assert.equal(request.method, "repo.agentRuntime.sessions.await");
    fixture.die();
  };
  const invocation = runWait(fixture, ["runtime", "status", "--task", taskId, "--wait", "--no-stream"]);
  try {
    const result = await invocation.result(20_000);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.receipt.code, "daemon_gone");
    assert.deepEqual(result.receipt.taskIds, [taskId]);
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
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: { readonly payload: Record<string, unknown> };
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
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
      repos: [
        {
          repoId: "runtime-wait",
          canonicalRoot: root,
          displayName: "Runtime Wait",
          authoredBranch: "main",
          mode: "local",
          connectionId: "local",
          state: "enabled",
          registeredAt: "2026-07-07T00:00:00.000Z",
        },
      ],
    }),
  );
  let server: net.Server;
  const start = async (): Promise<void> => {
      rmSync(socketPath, { force: true });
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
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
      writeFileSync(daemonPidPath(userRoot, daemonId), `${process.pid}\n`);
    },
    fixture = {
      root,
      userRoot,
      daemonId,
      onRequest: () => undefined,
      die: () => {
        rmSync(daemonPidPath(userRoot, daemonId), { force: true });
        if (server.listening) server.close();
        for (const socket of sockets) socket.destroy();
        rmSync(socketPath, { force: true });
      },
      restart: async () => {
        await new Promise<void>((resolve) => {
          if (!server.listening) resolve();
          else {
            server.once("close", resolve);
            fixture.die();
          }
        });
        await start();
      },
      close: async () => {
        fixture.die();
        await new Promise<void>((resolve) => {
          if (!server.listening) resolve();
          else server.close(() => resolve());
        });
        rmSync(parent, { recursive: true, force: true });
      },
    } satisfies FixtureDaemon;
  await start();
  return fixture;
}

function runWait(
  fixture: FixtureDaemon,
  args: readonly string[] = ["runtime", "status", runtimeSessionId, "--wait", "--no-stream"],
  json = true,
): {
  readonly closed: boolean;
  readonly result: (timeoutMs: number) => Promise<InvocationResult>;
  readonly stop: () => void;
} {
  const { HARNESS_DAEMON_ENDPOINT: _endpoint, HARNESS_DAEMON_REPO_ID: _repoId, ...baseEnv } = process.env,
    child = spawn(process.execPath, [cli, "--root", fixture.root, ...(json ? ["--json"] : []), ...args], {
      env: {
        ...baseEnv,
        HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
        HARNESS_DAEMON_ID: fixture.daemonId,
        HARNESS_DAEMON_REPO_ID: "runtime-wait",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let closed = false,
    stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const completion = new Promise<InvocationResult>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve({
        code,
        receipt: json && stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {},
        stdout,
        stderr,
      });
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
  readonly stdout: string;
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

function awaitReceipt(
  overrides: {
    readonly outcome?: string;
    readonly exitCode?: number;
    readonly code?: string;
    readonly reason?: string;
    readonly resultText?: string;
    readonly inFlight?: readonly string[];
    readonly summary?: string;
  } = {},
): Record<string, unknown> {
  const outcome = overrides.outcome ?? "succeeded",
    code = overrides.code ?? null,
    reason = overrides.reason ?? null,
    resultText = overrides.resultText ?? "settled after reconnect";
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-status",
    mode: "any",
    outcome,
    ...(reason ? { code, reason } : {}),
    sessions: [
      {
        runtimeSessionId,
        outcome,
        exitCode: overrides.exitCode ?? 0,
        code,
        reason,
        resultText,
      },
    ],
    inFlight: (overrides.inFlight ?? []).map((id) => ({ runtimeSessionId: id, liveness: "live" })),
    unavailable: [],
    summary: overrides.summary ?? resultText,
    exitCode: overrides.exitCode ?? 0,
  };
}

function runtimeStatus(terminal: boolean): Record<string, unknown> {
  const settlement = terminal ? { outcome: "succeeded", exitCode: 0, code: null, reason: null } : null;
  return {
    ok: true,
    status: "ready",
    settlement,
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
