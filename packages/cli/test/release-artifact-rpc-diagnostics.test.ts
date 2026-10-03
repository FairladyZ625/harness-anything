// harness-test-tier: fast
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { connectSocket } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { daemonPidPath } from "@harness-anything/daemon/internal/daemon-singleton";
import {
  daemonLifecycleLogPath,
  openDaemonLifecycleLog,
  readDaemonLifecycleRecords,
} from "@harness-anything/daemon/internal/lifecycle-log";
import { artifactRpcDiagnostics } from "./release-artifact-rpc-diagnostics.fixture.ts";

for (const mode of ["connected", "missing", "deadline"] as const) {
  test(`Artifact RPC diagnostics preserve ${mode} evidence before fixture cleanup`, async (context) => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-artifact-rpc-")),
      daemonId = "diagnostic",
      // Keep the socket inside this fixture; Windows uses its isolated named pipe instead.
      socketPath =
        process.platform === "win32" ? localUserDaemonEndpoint(userRoot, daemonId) : path.join(userRoot, "daemon.sock"),
      server = net.createServer((socket) => socket.end()),
      lines: string[] = [],
      secret = "must-not-appear-in-diagnostic",
      trace = artifactRpcDiagnostics(userRoot, daemonId, (line) => lines.push(line)),
      request = trace(async (target: { socketPath: string }, _method: string, _params: unknown, timeout: number) => {
        const socket = await connectSocket(target.socketPath, timeout);
        socket.end();
        return "original-result";
      });
    try {
      writeFileSync(daemonPidPath(userRoot, daemonId), String(process.pid));
      openDaemonLifecycleLog({ userRoot, daemonId }).record({ event: "process_start", error: secret });
      writeFileSync(
        path.join(userRoot, "logs", `daemon-${daemonId}-conn-20261004.jsonl`),
        JSON.stringify({ event: "conn_open", conn: "c-1", detail: secret }) + "\n",
      );
      if (mode !== "missing") await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      if (mode === "deadline") context.mock.timers.enable({ apis: ["setTimeout"] });
      const pending = request({ socketPath }, "test", { token: secret }, 75);
      if (mode === "deadline") context.mock.timers.tick(75);
      if (mode === "connected") assert.equal(await pending, "original-result");
      else await assert.rejects(pending, mode === "deadline" ? /daemon_unavailable/u : /ENOENT/u);
      assert.equal(lines.length, 1);
      assert.ok(!lines[0].includes(secret));
      const evidence = JSON.parse(lines[0]);
      assert.equal(evidence.schema, "release-artifact-rpc/v1");
      assert.equal(evidence.endpoint, socketPath);
      assert.equal(evidence.before.processState, "alive");
      assert.equal(evidence.after.pid, process.pid);
      assert.equal(evidence.lifecycle[0].event, "process_start");
      assert.equal(evidence.connections[0].event, "conn_open");
      assert.equal(evidence.connectTimeoutMs, 75);
      assert.equal(evidence.events[0].event, "created");
      assert.ok(evidence.elapsedMs >= 0);
      assert.equal(
        evidence.outcome,
        mode === "connected" ? "resolved" : mode === "deadline" ? "connect-deadline" : "ENOENT",
      );
      assert.equal(
        evidence.events.some((event: { event: string }) => event.event === "connect"),
        mode === "connected",
      );
      if (mode === "deadline") {
        assert.equal(evidence.sockets[0].destroyed, true);
        assert.equal(evidence.sockets[0].bytesWritten, 0);
        assert.ok(evidence.firstTimerTurnMs >= 0);
      }
      assert.equal(channel("net.client.socket").hasSubscribers, false);
    } finally {
      context.mock.timers.reset();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
}

for (const outcome of ["resolved", "rejected"] as const) {
  test(`Artifact RPC diagnostics preserve the original ${outcome} value when lifecycle reading fails`, async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-artifact-rpc-")),
      daemonId = "diagnostic",
      secret = "must-not-appear-in-read-error",
      lines: string[] = [],
      original = { token: secret },
      rejection = Object.assign(new Error(secret), { code: "original-rejection" }),
      trace = artifactRpcDiagnostics(userRoot, daemonId, (line) => lines.push(line)),
      request = trace(async (_target: { socketPath: string }) => {
        if (outcome === "rejected") throw rejection;
        return original;
      });
    try {
      mkdirSync(daemonLifecycleLogPath(userRoot, daemonId), { recursive: true });
      assert.throws(() => readDaemonLifecycleRecords(userRoot, daemonId), { code: "EISDIR" });
      const pending = request({ socketPath: path.join(userRoot, "daemon.sock") });
      if (outcome === "resolved") assert.equal(await pending, original);
      else await assert.rejects(pending, (error) => error === rejection);
      assert.equal(lines.length, 1);
      const evidence = JSON.parse(lines[0]);
      assert.deepEqual(evidence.lifecycle, { readError: "EISDIR" });
      assert.equal(evidence.outcome, outcome === "resolved" ? "resolved" : "original-rejection");
      assert.ok(!lines[0].includes(secret));
      assert.equal(channel("net.client.socket").hasSubscribers, false);
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
}
