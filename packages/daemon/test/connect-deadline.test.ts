// harness-test-tier: fast
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { connectSocket, requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";

for (const transport of ["local", "tcp"] as const) {
  test(`${transport}: an accepted connection survives a caller stalled before polling connect`, async (context) => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-connect-deadline-")),
      accepted = new Int32Array(new SharedArrayBuffer(12)),
      worker = new Worker(
        `
        const net = require("node:net");
        const { parentPort, workerData } = require("node:worker_threads");
        const accepted = new Int32Array(workerData.accepted);
        const server = net.createServer((socket) => {
          Atomics.store(accepted, 0, 1);
          Atomics.notify(accepted, 0);
          socket.on("error", () => {});
          let pending = "";
          socket.on("data", (chunk) => {
            pending += chunk.toString();
            let end;
            while ((end = pending.indexOf("\\n")) >= 0) {
              const request = JSON.parse(pending.slice(0, end));
              pending = pending.slice(end + 1);
              Atomics.add(accepted, request.method === "protocol.hello" ? 1 : 2, 1);
              socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\\n");
            }
          });
        });
        server.listen(workerData.endpoint, () => {
          const address = server.address();
          parentPort.postMessage(typeof address === "string" ? address : "tcp://127.0.0.1:" + address.port);
        });
      `,
        {
          eval: true,
          workerData: {
            accepted: accepted.buffer,
            endpoint:
              transport === "tcp"
                ? { host: "127.0.0.1", port: 0 }
                : process.platform === "win32"
                  ? localUserDaemonEndpoint(userRoot, "deadline")
                  : path.join(userRoot, "daemon.sock"),
          },
        },
      );
    try {
      const [endpoint] = await once(worker, "message");
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        // Enter from check, so an overdue deadline can run before the next poll.
        setImmediate(() => {
          const started = performance.now(),
            pending = requestDaemonJsonRpcAt(endpoint, "write.once", {}, 75, 5_000);
          pending.then(resolve, reject);
          // The server runs independently: accept is observed while this caller cannot poll.
          process.nextTick(() => {
            assert.notEqual(Atomics.wait(accepted, 0, 0, 5_000), "timed-out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            context.diagnostic(`accepted=${Atomics.load(accepted, 0)} callerStallMs=${performance.now() - started}`);
          });
        });
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(Atomics.load(accepted, 1), 1, "exactly one handshake");
      assert.equal(Atomics.load(accepted, 2), 1, "the command is sent exactly once");
    } finally {
      await worker.terminate();
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
}

test("a connection that never completes still fails after the deadline and one poll turn", async (context) => {
  const socket = new net.Socket();
  context.mock.method(net, "createConnection", () => socket);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = connectSocket("test-pending-socket", 75),
    rejected = assert.rejects(pending, /^Error: daemon_unavailable$/u);
  context.mock.timers.tick(75);
  assert.equal(socket.destroyed, false, "the deadline must allow polling before destruction");
  await rejected;
  assert.equal(socket.destroyed, true);
});

test("a missing local endpoint preserves its native connection error", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-connect-missing-"));
  try {
    await assert.rejects(connectSocket(localUserDaemonEndpoint(userRoot, "missing"), 75), {
      code: "ENOENT",
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a refused loopback TCP connection preserves ECONNREFUSED", async () => {
  const server = net.createServer();
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await assert.rejects(connectSocket(`tcp://127.0.0.1:${address.port}`, 75), { code: "ECONNREFUSED" });
});
