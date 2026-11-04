// harness-test-tier: fast
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

function timingFor(adjustFrameArrival: ((observedAtMs: number) => number) | undefined, line: string) {
  return new Promise<{ frameReceivedAt: number; observedAt: number; frameBytes: number | undefined }>(
    (resolve, reject) => {
      const input = Readable.from([line]),
        output = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        authContext: DaemonAuthenticationContext = {
          transportKind: "unix-socket",
          unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" },
        };
      const connection = serveJsonRpcStream({
        input,
        output,
        transportKind: "unix-socket",
        authContext,
        createProtocolServer: () => ({
          handle: async (_request, timing) => {
            resolve({
              frameReceivedAt: timing?.frameReceivedAt ?? 0,
              observedAt: Date.now(),
              frameBytes: timing?.frameBytes,
            });
            return { jsonrpc: "2.0", id: 1, result: { ok: true } };
          },
          close: () => undefined,
        }),
        ...(adjustFrameArrival === undefined ? {} : { adjustFrameArrival }),
      });
      input.on("error", reject);
      setTimeout(() => connection.close(), 1_000).unref();
    },
  );
}

test("a frame read after a main-thread stall is dated earlier so its queue wait is visible", async () => {
  const line = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.status", params: {} })}\n`,
    normal = await timingFor(undefined, line),
    stalled = await timingFor((observedAtMs) => observedAtMs - 250, line);
  assert.ok(normal.observedAt - normal.frameReceivedAt < 100);
  assert.ok(stalled.observedAt - stalled.frameReceivedAt >= 240, JSON.stringify(stalled));
  assert.equal(stalled.frameBytes, Buffer.byteLength(line));
});

test("the frame reader reports the byte length of a complete line", async () => {
  const request = { jsonrpc: "2.0", id: 1, method: "daemon.status", params: { padding: "x".repeat(50) } },
    line = `${JSON.stringify(request)}\n`,
    measured = await timingFor((observedAtMs) => observedAtMs, line);
  assert.equal(measured.frameBytes, Buffer.byteLength(line));
});
