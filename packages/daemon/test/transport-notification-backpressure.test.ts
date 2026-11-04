// harness-test-tier: fast
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const authContext: DaemonAuthenticationContext = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" },
};

test("a notification waits for drain when the output socket is full", async () => {
  let emit!: (method: string, params: Record<string, unknown>) => Promise<void>;
  let release!: () => void;
  let writes = 0;
  const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        writes += 1;
        release = callback;
      },
    }),
    connection = serveJsonRpcStream({
      input: new Readable({ read() {} }),
      output,
      transportKind: "unix-socket",
      authContext,
      createProtocolServer: (_auth, nextEmit) => {
        emit = nextEmit;
        return { handle: async () => undefined, close: () => undefined };
      },
    });
  try {
    let settled = false;
    const sent = emit("fixture.notification", { value: 1 }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 1);
    assert.equal(settled, false, "backpressure must hold the notification until drain");
    release();
    await sent;
    assert.equal(settled, true);
  } finally {
    connection.close();
  }
});
