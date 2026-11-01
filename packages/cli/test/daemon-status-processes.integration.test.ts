// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startDaemon } from "@harness-anything/daemon/internal/runtime";
import { openDaemonLifecycleLog } from "@harness-anything/daemon/internal/lifecycle-log";
import { writeDaemonStoppedMarker } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { status } from "../src/daemon/control-status.ts";

test("status exposes a live old process alongside its successor and while the endpoint is unavailable", async () => {
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
    assert.deepEqual(live.shuttingDownProcesses, [
      {
        pid: old.pid,
        state: "exit_incomplete",
        outcome: "stop_requested",
        since: (live.shuttingDownProcesses as { since: string }[])[0]!.since,
      },
    ]);
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
