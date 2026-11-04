// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ensureLocalDaemonRunning, type DaemonLaunchSpec } from "../src/client/daemon-autostart.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { daemonPidPath, daemonSingletonLockPath } from "../src/daemon-singleton.ts";
import { readDaemonLifecycleGeneration } from "../src/lifecycle-log.ts";

// The public runner builds the daemon used by cli/src/index.ts before this file starts.
for (const entry of [path.resolve("packages/daemon/src/bin.ts"), path.resolve("packages/daemon/dist/index.js")]) {
  test(`startup reports its generation before loading the server graph (${entry.endsWith(".ts") ? "source" : "dist"})`, async (context) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-startup-progress-")),
      daemonId = "startup-progress",
      endpoint = localUserDaemonEndpoint(root, daemonId),
      release = path.join(root, "release"),
      timeline = path.join(root, "timeline.jsonl"),
      hook = path.join(root, "hold-server.mjs"),
      started = performance.now(),
      loadCpuMs = Number(process.env.FLEET_STRESS_DAEMON_IMPORT_CPU_MS ?? 0),
      workers = Number(process.env.FLEET_STRESS_DAEMON_WORKERS ?? 0),
      stop = new Int32Array(new SharedArrayBuffer(4)),
      pressure = Array.from(
        { length: workers },
        () =>
          new Worker(
            `
        const { workerData } = require('node:worker_threads');
        const { pbkdf2Sync } = require('node:crypto');
        const stop = new Int32Array(workerData);
        while (!Atomics.load(stop, 0)) pbkdf2Sync('startup', 'load', 10000, 32, 'sha256');
      `,
            { eval: true, workerData: stop.buffer },
          ),
      );
    let child: ChildProcess | undefined,
      stderr = "",
      released = false;
    writeFileSync(
      hook,
      `
      import { registerHooks } from 'node:module';
      import { appendFileSync, existsSync } from 'node:fs';
      import { pbkdf2Sync } from 'node:crypto';
      const mark = (stage) => appendFileSync(${JSON.stringify(timeline)}, JSON.stringify({ stage, at: Date.now(), uptimeMs: process.uptime() * 1000 }) + '\\n');
      mark('preload');
      registerHooks({ load(url, options, next) {
        const name = new URL(url).pathname;
        if (/\\/daemon\\/src\\/(?:bin|runtime)\\.(?:ts|js)$/.test(name)) mark(name);
        if (/\\/daemon-host\\.(?:ts|js)$/.test(name)) {
          mark('server-import-start');
          const cpu = process.cpuUsage(), deadline = Date.now() + 90000;
          while (!existsSync(${JSON.stringify(release)}) || (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000 < ${loadCpuMs}) {
            if (Date.now() >= deadline) throw new Error('server import was never released');
            pbkdf2Sync('startup', 'load', 1000, 32, 'sha256');
          }
          mark('server-import-released');
        }
        return next(url, options);
      }});
    `,
    );
    const launch: DaemonLaunchSpec = {
      command: process.execPath,
      args: [entry, "serve", "--user-root", root, "--daemon-id", daemonId],
      env: {
        ...process.env,
        HARNESS_ACTOR: "agent:harness-test",
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
      },
    };
    try {
      const result = await ensureLocalDaemonRunning({
        socketPath: endpoint,
        invokingRoot: process.cwd(),
        launch: () => launch,
        spawnDetached: async (spec) => {
          child = spawn(spec.command, spec.args, {
            env: spec.env,
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          });
          child.stderr!.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          await once(child, "spawn");
        },
        onProgress: () => {
          if (!released && readFileSync(timeline, "utf8").includes("server-import-start")) {
            released = true;
            writeFileSync(release, "observed lifecycle progress while the server import was blocked");
          }
        },
      });
      context.diagnostic(
        JSON.stringify({
          entry,
          result,
          elapsedMs: performance.now() - started,
          loadCpuMs,
          workers,
          timeline: readFileSync(timeline, "utf8"),
          lifecycle: readDaemonLifecycleGeneration(root, daemonId),
          stderr,
        }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(released, true, "an observable generation must cover the server module load");
      assert.equal(
        readDaemonLifecycleGeneration(root, daemonId).filter((record) => record.event === "process_start").length,
        1,
      );
    } finally {
      writeFileSync(release, "cleanup");
      Atomics.store(stop, 0, 1);
      await Promise.all(pressure.map((worker) => worker.terminate()));
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test(`a failed server import terminates the generation and releases its claim (${entry.endsWith(".ts") ? "source" : "dist"})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-startup-import-failure-")),
      daemonId = "failed-import",
      hook = path.join(root, "reject-server.mjs");
    writeFileSync(
      hook,
      `
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, options, next) {
        if (/\\/daemon-host\\.(?:ts|js)$/.test(new URL(url).pathname)) throw new Error('injected server import failure');
        return next(url, options);
      }});
    `,
    );
    const child = spawn(process.execPath, [entry, "serve", "--user-root", root, "--daemon-id", daemonId], {
      env: {
        ...process.env,
        HARNESS_ACTOR: "agent:harness-test",
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 1, stderr);
      assert.match(stderr, /injected server import failure/u);
      const records = readDaemonLifecycleGeneration(root, daemonId);
      assert.deepEqual(
        records.map((record) => record.event),
        ["process_start", "process_exit"],
      );
      assert.equal(records.at(-1)?.outcome, "startup_failed");
      assert.match(records.at(-1)?.error ?? "", /injected server import failure/u);
      assert.equal(existsSync(daemonPidPath(root, daemonId)), false);
      assert.equal(existsSync(daemonSingletonLockPath(root, daemonId)), false);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
}
