// harness-test-tier: integration
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { streamAgentRuntimeAt, type DaemonStreamLost } from "../src/client/local-json-rpc-stream.ts";

// #1654: a stream that had attached once reconnected every 40ms forever, invisibly, while the
// daemon was too busy to answer — a connection storm that kept the daemon busy. The harness below
// is that incident in miniature: the "daemon" accepts one attach, dies, and then destroys every
// further connection instantly. The stream must back off, spend a bounded attempt budget, and
// finish with an observable failure instead of spinning.
test("an attached stream exhausts a bounded reconnect budget and reports the loss", async () => {
  const accepted: number[] = [];
  // Connection 1 serves a valid attach and dies; connection 2 serves attach again (a recovered
  // daemon must refresh the budget); every later connection is destroyed on arrival.
  const server = net.createServer((socket) => {
    accepted.push(1);
    if (accepted.length <= 2) {
      socket.on("data", () =>
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { ok: true, status: "attached", runtimeSessionId: "session-bound", cursor: "stream:0", events: [] },
          }) + "\n",
        ),
      );
      setTimeout(() => socket.destroy(), 50);
    } else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the test server must expose a TCP port");
  const socketPath = `${address.address}:${address.port}`;
  try {
    const values: unknown[] = [];
    let lost: DaemonStreamLost | undefined;
    let closeNotifications = 0;
    const detach = await streamAgentRuntimeAt({
      socketPath,
      openSocket: () => Promise.resolve(net.createConnection({ host: address.address, port: address.port })),
      repoId: "stream-bound",
      payload: { runtimeSessionId: "session-bound", afterCursor: "stream:0" },
      onValue: (value) => values.push(value),
      onClosed: (failure) => {
        closeNotifications += 1;
        lost = failure;
      },
    });
    try {
      const started = Date.now();
      assert.equal((values[0] as { readonly ok: boolean }).ok, true, "the initial attach must succeed");
      for (const deadline = Date.now() + 30_000; lost === undefined && Date.now() < deadline; ) await delay(50);
      assert.ok(lost, "the stream must report its loss");
      assert.equal(lost.code, "daemon_stream_lost");
      assert.equal(closeNotifications, 1, "stream loss must be reported exactly once");
      // One successful reconnect refreshed the budget, so the fatal episode gets its full five
      // attempts: 250 + 500 + 1000 + 2000 + 4000 ms of backoff precede the give-up.
      assert.equal(lost.attempts, 5, `attempts=${lost.attempts}`);
      assert.ok(Date.now() - started >= 7_500, "the retries must actually back off");
      assert.equal(
        accepted.length,
        7,
        `exactly one attach, one recovery, and five failed attempts; got ${accepted.length}`,
      );
      const settled = accepted.length;
      await delay(2_000);
      assert.equal(accepted.length, settled, "a stream that gave up must stop connecting");
    } finally {
      detach();
    }
  } finally {
    server.close();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
