// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { runProcessTextAsync } from "../src/process-port.ts";

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
