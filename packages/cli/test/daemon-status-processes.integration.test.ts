// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startDaemon } from "@harness-anything/daemon/internal/runtime";
import { openDaemonLifecycleLog } from "@harness-anything/daemon/internal/lifecycle-log";
import { writeDaemonStoppedMarker } from "@harness-anything/daemon/internal/client/daemon-autostart";
import {
  daemonDiagnosticsEndpoint,
  localUserDaemonEndpoint,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import { status } from "../src/daemon/control-status.ts";

test("status reports a draining old process until its terminal exit record, then lets its successor answer", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-status-processes-")),
    daemonId = "status-processes",
    old = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(old, "exit");
  await once(old, "spawn");
  const lifecycle = openDaemonLifecycleLog({ userRoot, daemonId, pid: old.pid! });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    lifecycle.record({ event: "process_start" });
    lifecycle.record({ event: "process_stopping", outcome: "stop_requested" });
    writeDaemonStoppedMarker(userRoot, daemonId);
    const flags = ["--root", userRoot];
    const draining = await status(userRoot, daemonId, flags);
    assert.equal(draining.ok, false);
    assert.equal(draining.code, "daemon_stopping");
    assert.match(String(draining.summary), new RegExp(`shutdown: pid=${old.pid} state=stopping`, "u"));
    lifecycle.record({ event: "process_exit", outcome: "stop_requested" });
    // Post-exit activity must not hide the earlier terminal claim.
    lifecycle.record({ event: "replica_sync_failed", repoId: "repo", error: "replication connection closed" });
    daemon = await startDaemon({ userRoot, daemonId });
    assert.ok("stop" in daemon);
    const live = await status(userRoot, daemonId, flags);
    assert.equal(live.ok, true, JSON.stringify(live));
    assert.equal(live.pid, process.pid);
    // The old process is still alive, but its generation recorded process_exit. That terminal
    // claim means "not draining"; keeping the pid here let a reused pid hold daemon_stopping.
    assert.deepEqual(live.shuttingDownProcesses, []);
    console.log(`status evidence: ${JSON.stringify(live)}`);
    old.kill();
    await exited;
    const settled = await status(userRoot, daemonId, flags);
    assert.deepEqual(settled.shuttingDownProcesses, []);
  } finally {
    if (old.exitCode === null && old.signalCode === null) old.kill("SIGKILL");
    await exited;
    if (daemon && "stop" in daemon) await daemon.stop();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test(
  "status --diagnostics names the held shutdown phase through the independent socket",
  { timeout: 15_000 },
  async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-status-diag-")),
      daemonId = "status-diag";
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      daemon = await startDaemon({
        userRoot,
        daemonId,
        runtimeDiscover: () => [],
        managedRbac: {
          resume: async () => {},
          run: async () => ({ ok: true }),
          loginListenerCertificate: () => null,
          stop: async () => {
            reached();
            await gate;
          },
        },
      });
    assert.ok("stop" in daemon);
    const stopping = daemon.stop();
    try {
      await blocked;
      const result = await status(userRoot, daemonId, ["--root", userRoot, "--diagnostics"]);
      assert.equal(result.ok, true);
      assert.equal(result.state, "stopping");
      assert.match(String(result.summary), /daemon.close.*phase=managed-rbac.stop/u);
      assert.ok(
        (result.waitingFor as { method: string; phase: string }[]).some(
          (op) => op.method === "daemon.close" && op.phase === "managed-rbac.stop",
        ),
      );
    } finally {
      release();
      await stopping;
      rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test("status ignores a stale exit record whose pid now belongs to another process", { timeout: 20_000 }, async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-status-reused-pid-")),
    daemonId = "status-reused-pid",
    // A pid number is not a process identity. This record names the current test process but was
    // written months earlier, exactly the shape the field's 2026-09 exit_incomplete records took
    // after pid reuse. A process_exit record is terminal, so the live pid cannot keep it draining.
    stale = openDaemonLifecycleLog({
      userRoot,
      daemonId,
      pid: process.pid,
      now: () => new Date("2026-09-28T21:54:51.318Z"),
    });
  try {
    stale.record({ event: "process_start" });
    stale.record({ event: "process_stopping", outcome: "build_superseded" });
    stale.record({ event: "process_exit", outcome: "build_superseded" });
    writeDaemonStoppedMarker(userRoot, daemonId);
    const result = await status(userRoot, daemonId, ["--root", userRoot]);
    assert.notEqual(result.code, "daemon_stopping", JSON.stringify(result));
    assert.equal(result.code, "daemon_unavailable", JSON.stringify(result));
    assert.deepEqual(result.shuttingDownProcesses, []);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test(
  "status reports the daemon's handshake rejection instead of a stale daemon_stopping",
  { timeout: 20_000 },
  async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-status-hello-rejected-")),
      daemonId = "status-hello-rejected",
      endpoint = localUserDaemonEndpoint(userRoot, daemonId),
      stale = openDaemonLifecycleLog({
        userRoot,
        daemonId,
        pid: process.pid,
        now: () => new Date("2026-09-28T21:54:51.318Z"),
      }),
      fake = await serveLineRpc(endpoint, (request) =>
        request.method === "protocol.hello"
          ? {
              ok: false,
              code: "unknown_field",
              rejectionExplanation: 'params contains an unknown field "buildCommit"',
              error: { code: "unknown_field" },
            }
          : { ok: true, summary: "the rejected handshake must not reach daemon.status" },
      );
    try {
      stale.record({ event: "process_start" });
      stale.record({ event: "process_stopping", outcome: "build_superseded" });
      const result = await status(userRoot, daemonId, ["--root", userRoot]);
      assert.equal(result.code, "unknown_field", JSON.stringify(result));
      assert.match(String((result.error as { readonly hint?: unknown }).hint), /unknown field/u);
      assert.match(String(result.summary), /unknown_field/u);
    } finally {
      await fake.close();
      rmSync(userRoot, { recursive: true, force: true });
    }
  },
);

test(
  "status --diagnostics accepts the previous diagnostics worker's bare hello reply",
  { timeout: 20_000 },
  async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-status-legacy-diag-")),
      daemonId = "status-legacy-diag",
      endpoint = localUserDaemonEndpoint(userRoot, daemonId),
      diagnostics = daemonDiagnosticsEndpoint(endpoint),
      fake = await serveLineRpc(diagnostics, (request) =>
        request.method === "protocol.hello"
          ? { ok: true }
          : { ok: true, command: "daemon-status", state: "running", pid: process.pid, summary: "daemon status" },
      );
    try {
      const result = await status(userRoot, daemonId, ["--root", userRoot, "--diagnostics"]);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.state, "running");
    } finally {
      await fake.close();
      rmSync(userRoot, { recursive: true, force: true });
    }
  },
);

function serveLineRpc(
  socketPath: string,
  handle: (request: { readonly method?: unknown; readonly params?: unknown }) => unknown,
): Promise<{ readonly close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>(),
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.setEncoding("utf8");
      // The client half-closes after its last request; echo that FIN so neither side keeps the
      // connection alive when a test assertion returns early.
      socket.on("end", () => socket.end());
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const request = JSON.parse(line) as {
            readonly id?: unknown;
            readonly method?: unknown;
            readonly params?: unknown;
          };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result: handle(request) })}\n`);
        }
      });
    });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () =>
      resolve({
        close: async () => {
          // `net.Server.closeAllConnections` is not available on every supported runtime; keep
          // the accepted sockets ourselves so cleanup cannot leave a listening handle behind.
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((closed) => server.close(() => closed()));
          rmSync(socketPath, { force: true });
        },
      }),
    );
  });
}
