// harness-test-tier: integration
import { fixtureDaemonHello } from "./fixtures/daemon-hello.ts";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { streamAgentRuntimeAt, type DaemonStreamLost } from "../src/daemon-host/client/local-json-rpc-stream.ts";
import { runtimeCursor } from "./fixtures/runtime-stream.ts";

// #1654: a stream that had attached once reconnected every 40ms forever, invisibly, while the
// daemon was too busy to answer — a connection storm that kept the daemon busy. The harness below
// is that incident in miniature: the "daemon" accepts one attach, dies, and then destroys every
// further connection instantly. The stream must back off, spend a bounded attempt budget, and
// finish with an observable failure instead of spinning.
test("an attached stream exhausts a bounded reconnect budget and reports the loss", { timeout: 300_000 }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stream-bound-")),
    socketPath = localUserDaemonEndpoint(parent, "stream-bound");
  try {
    const accepted: number[] = [];
    // A receipt without stream progress does not refill the retry budget.
    const server = net.createServer((socket) => {
      accepted.push(1);
      if (accepted.length <= 2) {
        socket.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("protocol.hello")) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: fixtureDaemonHello() })}\n`);
            return;
          }
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                ok: true,
                status: "attached",
                runtimeSessionId: "session-bound",
                cursor: runtimeCursor("stream-bound", 0),
                events: [],
              },
            }) + "\n",
          );
          setImmediate(() => socket.destroy());
        });
      } else socket.destroy();
    });
    await new Promise<void>((resolve) => {
      mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      server.listen(socketPath, resolve);
    });
    const values: unknown[] = [];
    const failure = Promise.withResolvers<DaemonStreamLost>();
    const detach = await streamAgentRuntimeAt({
      socketPath,
      repoId: "stream-bound",
      payload: { runtimeSessionId: "session-bound" },
      onValue: (value) => values.push(value),
      onClosed: failure.resolve,
    });
    try {
      assert.equal((values[0] as { readonly ok: boolean }).ok, true, "the initial attach must succeed");
      const lost = await failure.promise;
      assert.equal(lost.code, "daemon_stream_lost");
      assert.equal(lost.attempts, 5, `attempts=${lost.attempts}`);
      assert.equal(accepted.length, 6, "one attach and five retries, including a receipt without progress");
    } finally {
      detach();
      server.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
