// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { waitForArrival } from "../../../tools/fixtures/event-arrival.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { readDaemonPid } from "../src/daemon-singleton.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";

// poll-spin-class: durable-poll - durable predicate read (assert.ok(Date.now() < deadline, message);); no product event port at the wait site
// poll-spin-class: durable-poll - durable predicate read (async function eventually(); no product event port at the wait site
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  budgetMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
function killWorker(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function terminateDaemon(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

for (const supervised of [true, false])
  test(
    `${supervised ? "supervised" : "on-demand"} supersession exits with live runtime and restarts the disk build`,
    { skip: process.platform === "win32" ? "requires POSIX detached process-group semantics" : false, timeout: 60_000 },
    async () => {
      const parent = mkdtempSync(path.join(tmpdir(), "ha-supervised-supersession-")),
        buildRoot = mkdtempSync(path.join(path.resolve("packages/daemon"), ".supersession-fixture-")),
        dist = path.join(buildRoot, "dist"),
        userRoot = path.join(parent, "user"),
        rootDir = path.join(parent, "repo"),
        marker = path.join(dist, "build-id.txt"),
        daemonId = "supervised-test",
        workerFile = path.join(parent, "worker.pid"),
        providerReady = path.join(parent, "provider-ready"),
        entry = path.join(dist, "daemon/src/bin.js"),
        endpoint = localUserDaemonEndpoint(userRoot, daemonId),
        preload = path.join(parent, "preload.mjs");
      mkdirSync(rootDir, { recursive: true });
      cpSync(path.resolve("packages/daemon/dist"), dist, { recursive: true });
      assert.ok(existsSync(entry), `daemon build is missing at ${entry}`);
      writeFileSync(marker, "build-a\n");
      const moduleUrl = pathToFileURL(path.resolve("packages/daemon/src/runtime-spawn-process.ts")).href;
      writeFileSync(
        preload,
        `import fs from "node:fs"; import path from "node:path"; import { launchNative } from ${JSON.stringify(moduleUrl)};\nif (process.argv.includes("--service") && fs.readFileSync(${JSON.stringify(marker)}, "utf8").trim() === "build-a") { const rootDir = ${JSON.stringify(rootDir)}, dispatchId = "dispatch_111111111111111111111111", streamRoot = path.join(rootDir, ".harness", "runtime", "dispatches"); fs.mkdirSync(streamRoot, { recursive: true }); fs.writeFileSync(path.join(streamRoot, dispatchId + ".jsonl"), "{}\\n"); const worker = launchNative({ executablePath: process.execPath, args: ["-e", 'process.stdin.resume(); process.stdin.once("end", () => require("fs").writeFileSync(process.argv[1], "ready")); setInterval(() => {}, 1000)', ${JSON.stringify(providerReady)}], env: process.env, cwd: rootDir, prompt: "hold" }, { rootDir, dispatchId }); fs.writeFileSync(${JSON.stringify(workerFile)}, String(worker.pid)); setInterval(() => {}, 1000); }\n`,
      );
      const env = {
        ...process.env,
        HOME: parent,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
      };
      delete env.HARNESS_ACTOR;
      delete env.HARNESS_EXECUTION_CREDENTIAL;
      delete env.HARNESS_DAEMON_ENDPOINT;
      delete env.HARNESS_DAEMON_RELAY;
      const start = () =>
        spawn(
          process.execPath,
          [
            entry,
            "--service",
            "--user-root",
            userRoot,
            "--daemon-id",
            daemonId,
            ...(supervised ? ["--supervised"] : []),
          ],
          {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
      const old = start(),
        exited = once(old, "exit");
      let successor: ReturnType<typeof spawn> | undefined,
        workerPid = 0;
      try {
        await eventually(() => existsSync(workerFile) && existsSync(providerReady), "runtime did not start");
        workerPid = Number(readFileSync(workerFile, "utf8"));
        await eventually(async () => {
          try {
            return (
              (await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 1000, 1000, undefined, true)).ok === true
            );
          } catch {
            return false;
          }
        }, "daemon did not start");
        writeFileSync(marker, "build-b\n");
        await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2000, 2000, undefined, true);
        const outcome = await exited;
        assert.deepEqual(outcome, [supervised ? 75 : 0, null]);
        assert.doesNotThrow(() => process.kill(workerPid, 0));
        if (supervised) successor = start();
        await eventually(async () => {
          try {
            const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 1000, 1000, undefined, true);
            return (status.build as { loadedBuildId?: string }).loadedBuildId === "build-b";
          } catch {
            return false;
          }
        }, "supervisor did not start the disk build");
        assert.doesNotThrow(() => process.kill(workerPid, 0));
      } finally {
        old.kill("SIGKILL");
        successor?.kill("SIGTERM");
        if (workerPid) killWorker(workerPid);
        await exited;
        if (successor && successor.exitCode === null && successor.signalCode === null) await once(successor, "exit");
        if (!supervised) {
          const successorPid = readDaemonPid(userRoot, daemonId);
          if (successorPid !== null && successorPid !== old.pid) {
            terminateDaemon(successorPid);
            await waitForArrival(
              () => (readDaemonPid(userRoot, daemonId) === null ? true : null),
              (arrive) => {
                const watcher = watch(userRoot, arrive);
                return () => watcher.close();
              },
            );
          }
        }
        rmSync(parent, { recursive: true, force: true });
        rmSync(buildRoot, { recursive: true, force: true });
      }
    },
  );
