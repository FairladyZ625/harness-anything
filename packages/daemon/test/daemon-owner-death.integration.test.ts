// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLocalDaemonRunning } from "../src/client/daemon-autostart.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { openDaemonJsonRpcClientAt } from "../src/client/local-json-rpc-client.ts";
import { daemonPidPath, daemonSocketProbe } from "../src/daemon-singleton.ts";

test("the real daemon entry serves while its owner lives and drains after the owner exits", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-owner-death-")),
    daemonId = "owner-death",
    endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    owner = spawn(process.execPath, ["-e", "process.send('ready'); process.on('message', () => process.exit(0));"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
  let daemon: ChildProcess | undefined;
  let stderr = "";
  try {
    await once(owner, "message", { signal: AbortSignal.timeout(5_000) });
    const ready = await ensureLocalDaemonRunning({
      socketPath: endpoint,
      invokingRoot: userRoot,
      launch: () => ({
        command: process.execPath,
        args: [path.resolve("packages/daemon/src/bin.ts"), "serve", "--user-root", userRoot, "--daemon-id", daemonId],
        env: { ...process.env, HARNESS_DAEMON_OWNER_PID: String(owner.pid) },
      }),
      spawnDetached: async (launch) => {
        daemon = spawn(launch.command, launch.args, { env: launch.env, stdio: ["ignore", "ignore", "pipe"] });
        daemon.stderr!.on("data", (chunk: Buffer) => {
          stderr += String(chunk);
        });
      },
    });
    assert.equal(ready.ok, true, `${ready.hint}\n${stderr}`);
    assert.ok(daemon);
    const client = await openDaemonJsonRpcClientAt(endpoint);
    try {
      const status = await client.request("daemon.status", {}, 5_000);
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.equal(daemon.exitCode, null, "a live owner keeps the daemon serving");
      assert.equal(existsSync(daemonPidPath(userRoot, daemonId)), true);
      const ownerExit = once(owner, "exit", { signal: AbortSignal.timeout(5_000) }),
        daemonExit = once(daemon, "exit", { signal: AbortSignal.timeout(5_000) });
      owner.send("exit");
      assert.equal((await ownerExit)[0], 0);
      assert.deepEqual(await daemonExit, [0, null], stderr);
    } finally {
      client.close();
    }
    assert.equal(existsSync(daemonPidPath(userRoot, daemonId)), false, "shutdown releases the singleton claim");
    assert.equal(await daemonSocketProbe(endpoint), false, "shutdown releases the listener");
  } finally {
    for (const child of [daemon, owner]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGKILL");
        await closed;
      }
    }
    rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
