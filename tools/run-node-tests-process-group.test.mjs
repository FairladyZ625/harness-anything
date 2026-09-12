// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test(
  "runner reaps descendants when the test host dies before its output pipes close",
  {
    skip: process.platform === "win32" ? "requires POSIX process groups and SIGKILL semantics" : false,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "ha-runner-host-exit-"));
    const preload = join(root, "host.mjs");
    writeFileSync(
      preload,
      `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (!args.includes('--test')) return spawn(command, args, options);
  return spawn(command, ['-e', ${JSON.stringify(`
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); console.log('DESCENDANT_READY'); setInterval(() => {}, 1000);"
  ], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_OPTIONS: '' } });
  console.log('HOST_PID=' + process.pid);
  child.unref();
  setInterval(() => {}, 1000);
`)}], options);
};
syncBuiltinESMExports();
`,
    );
    const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    delete env.NODE_TEST_CONTEXT;
    const runner = spawn(
      process.execPath,
      ["tools/run-node-tests.mjs", "--file", "tools/test-fixtures/runner-watchdog/open-handle.test.mjs"],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = once(runner, "close");
    let hostPid;
    let output = "";
    let deadline;
    try {
      await new Promise((resolveReady, reject) => {
        deadline = setTimeout(() => reject(new Error(`host did not start: ${output}`)), 10_000);
        runner.stdout.on("data", (chunk) => {
          output += chunk;
          const match = /HOST_PID=(\d+)/u.exec(output);
          if (match) hostPid = Number(match[1]);
          if (hostPid && output.includes("DESCENDANT_READY")) resolveReady();
        });
        runner.stderr.on("data", (chunk) => {
          output += chunk;
        });
      });
      clearTimeout(deadline);
      process.kill(hostPid, "SIGKILL");
      const result = await Promise.race([
        closed,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`runner waited for inherited pipes after host death: ${output}`)),
            5_000,
          );
        }),
      ]);
      assert.deepEqual(result, [1, null], output);
      assert.throws(() => process.kill(-hostPid, 0), { code: "ESRCH" });
    } finally {
      clearTimeout(deadline);
      if (hostPid) {
        try {
          process.kill(-hostPid, "SIGKILL");
        } catch (error) {
          assert.equal(error.code, "ESRCH");
        }
      }
      runner.kill("SIGKILL");
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
