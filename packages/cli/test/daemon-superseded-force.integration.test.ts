// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { daemonSocketProbe, readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";

// poll-spin-class: durable-poll - durable predicate read (assert.ok(Date.now() < deadline, message);); no product event port at the wait site
// poll-spin-class: durable-poll - durable predicate read (async function waitFor(predicate: () => boolean, message: string): Promise<void>); no product event port at the wait site
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test(
  "force stop can find a superseded daemon after its socket is released without killing the runtime",
  { skip: process.platform === "win32" ? "requires POSIX detached process-group semantics" : false, timeout: 30_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-superseded-force-")),
      userRoot = path.join(parent, "user"),
      rootDir = path.join(parent, "repo"),
      runtimeFile = path.join(parent, "runtime/dist/daemon/src/runtime.js"),
      marker = path.join(parent, "runtime/dist/build-id.txt"),
      providerReady = path.join(parent, "provider-ready"),
      daemonId = "superseded-pid-holder";
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(runtimeFile, "// fixture\n");
    writeFileSync(marker, "build-a\n");
    const child = fork(
      new URL("../../daemon/test/fixtures/superseded-pid-holder.fixture.ts", import.meta.url),
      [userRoot, rootDir, runtimeFile, providerReady],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let workerPid = 0;
    try {
      const [ready] = (await once(child, "message")) as [{ ready: boolean; workerPid: number }];
      assert.equal(ready.ready, true);
      workerPid = ready.workerPid;
      await waitFor(() => existsSync(providerReady), "runtime provider did not start");
      const released = once(child, "message");
      writeFileSync(marker, "build-b\n");
      await requestDaemonJsonRpcAt(
        localUserDaemonEndpoint(userRoot, daemonId),
        "daemon.status",
        {},
        2000,
        2000,
        undefined,
        true,
      );
      assert.equal((await released)[0], "released");
      assert.equal(await daemonSocketProbe(localUserDaemonEndpoint(userRoot, daemonId)), false);
      assert.doesNotThrow(() => process.kill(child.pid!, 0), "the outgoing daemon must still be alive");
      assert.equal(readDaemonPid(userRoot, daemonId), child.pid, "the live outgoing process remains discoverable");
      const env = { ...process.env };
      delete env.HARNESS_ACTOR;
      delete env.HARNESS_EXECUTION_CREDENTIAL;
      const cli = spawn(
        process.execPath,
        [
          path.resolve("packages/cli/src/index.ts"),
          "daemon",
          "stop",
          "--force",
          "--json",
          "--user-root",
          userRoot,
          "--daemon-id",
          daemonId,
        ],
        { env },
      );
      let stdout = "";
      cli.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const [code] = await once(cli, "close");
      assert.equal(code, 0, stdout);
      assert.equal(JSON.parse(stdout).forced, true);
      await exited;
      assert.doesNotThrow(() => process.kill(workerPid, 0), "runtime must survive daemon force stop");
    } finally {
      child.kill("SIGKILL");
      if (workerPid) killGroup(workerPid);
      await exited;
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
