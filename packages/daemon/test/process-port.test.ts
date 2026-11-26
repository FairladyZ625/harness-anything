// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { runProcessExitAsync, runProcessTextAsync } from "../src/daemon-host/process-port.ts";

test(
  "a timed out command releases pipes before their holder exits",
  {
    timeout: 90_000,
    skip: process.platform === "win32" ? "requires a pipe holder that can ignore SIGTERM" : false,
  },
  async (t) => {
    const ready = Promise.withResolvers<{ socket: Socket; pid: number }>(),
      server = createServer((socket) => {
        socket.once("data", (data) => ready.resolve({ socket, pid: Number(data.toString()) }));
      });
    const state: { holder?: Awaited<typeof ready.promise> } = {};
    t.after(async () => {
      state.holder?.socket.destroy();
      if (state.holder) {
        try {
          process.kill(state.holder.pid, "SIGKILL");
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const descendant = `
    process.on('SIGTERM', () => {});
    const socket = require('node:net').connect(${address.port}, '127.0.0.1', () => socket.write(String(process.pid)));
    socket.once('data', () => socket.end());
  `;
    const rejected = assert.rejects(
      runProcessTextAsync(
        process.execPath,
        [
          "-e",
          `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'});
  `,
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: 20_000 },
      ),
    );
    const holder = await ready.promise;
    state.holder = holder;
    await rejected;
    // The holder has no natural-exit timer: only this release can end it. Rejection therefore
    // proves pipe release, even while a descendant is still alive with inherited stdout/stderr.
    assert.equal(process.kill(holder.pid, 0), true);
    assert.equal(holder.socket.destroyed, false);
    const closed = once(holder.socket, "close");
    holder.socket.end("release");
    await closed;
  },
);

test("output past the 1 MiB default buffer needs an explicit maxBuffer", async () => {
  const twoMiB = ["-e", "process.stdout.write('x'.repeat(2 << 20))"];
  await assert.rejects(runProcessTextAsync(process.execPath, twoMiB), /maxBuffer/u);
  const stdout = await runProcessTextAsync(process.execPath, twoMiB, undefined, undefined, undefined, undefined, {
    maxBuffer: 4 << 20,
  });
  assert.equal(stdout.length, 2 << 20);
});

test("interactive stdin is kept open for the protocol exchange and its failure terminates the child", async () => {
  const result = await runProcessTextAsync(
    process.execPath,
    ["-e", "process.stdin.on('data',x=>process.stdout.write(x))"],
    undefined,
    undefined,
    async (child) => {
      child.stdin!.write("request");
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    },
    undefined,
    { timeoutMs: 1000 },
  );
  assert.equal(result, "request");
  const failure = new Error("interaction failed");
  await assert.rejects(
    runProcessTextAsync(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      undefined,
      undefined,
      async () => {
        throw failure;
      },
      undefined,
      { timeoutMs: 1000 },
    ),
    (error) => error === failure,
  );
});

test(
  "Windows .cmd timeout and abort terminate grandchild processes holding inherited pipes",
  {
    timeout: 30_000,
    skip: process.platform !== "win32" ? "Windows .cmd process-tree termination regression" : false,
  },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ha-process-port-win-"));
    const sockets = new Set<Socket>();
    const pids = new Set<number>();
    let resolveReady: ((pid: number) => void) | null = null;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", (data) => {
        const pid = Number(data.toString().trim());
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        resolveReady?.(pid);
        resolveReady = null;
      });
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already terminated by taskkill /T.
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeTempRepository(dir);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const scriptPath = path.join(dir, "holder.js");
    writeFileSync(
      scriptPath,
      [
        `const net = require("node:net");`,
        `const socket = net.connect(${address.port}, "127.0.0.1", () => socket.write(String(process.pid)));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    const cmdPath = path.join(dir, "launch-holder.cmd");
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`);

    const waitGrandchildPid = () =>
      new Promise<number>((resolve) => {
        resolveReady = resolve;
      });
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    // 1. Timeout path: runProcessExitAsync must reject with killed=true/signal and kill the grandchild.
    const timeoutPidPromise = waitGrandchildPid();
    const timeoutRun = assert.rejects(
      runProcessExitAsync(cmdPath, [], dir, undefined, undefined, undefined, { timeoutMs: 800 }),
      (error: unknown) => {
        const record = error as { readonly killed?: boolean; readonly signal?: string | null };
        assert.equal(record.killed, true);
        assert.equal(record.signal, "SIGTERM");
        return true;
      },
    );
    const timeoutGrandchildPid = await timeoutPidPromise;
    await timeoutRun;
    assert.equal(isAlive(timeoutGrandchildPid), false, `grandchild ${timeoutGrandchildPid} survived timeout`);

    // 2. AbortSignal path: aborting must kill the entire .cmd tree before settling.
    const controller = new AbortController();
    const abortPidPromise = waitGrandchildPid();
    const abortRun = assert.rejects(runProcessTextAsync(cmdPath, [], dir, undefined, undefined, controller.signal));
    const abortGrandchildPid = await abortPidPromise;
    controller.abort();
    await abortRun;
    assert.equal(isAlive(abortGrandchildPid), false, `grandchild ${abortGrandchildPid} survived abort`);
  },
);
