// harness-test-tier: integration
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough, Writable, type Readable } from "node:stream";
import test from "node:test";
import { serveJsonRpcStream } from "../src/index.ts";

test("JSON-RPC stream writes asynchronous server notifications and closes subscriptions", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  let notify: ((notification: unknown) => void) | undefined;
  let closes = 0;
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: serverToClient,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: (_authContext, _acceptedConnection, notificationSink) => {
      notify = notificationSink;
      return {
        handle: async () => undefined,
        close: async () => {
          closes += 1;
        }
      };
    }
  });

  notify?.({ jsonrpc: "2.0", method: "repo.projection.changed", params: { event: { schema: "projection-change/v1" } } });
  assert.deepEqual(await readFrame(serverToClient), {
    jsonrpc: "2.0",
    method: "repo.projection.changed",
    params: { event: { schema: "projection-change/v1" } }
  });

  await connection.close();
  assert.equal(closes, 1);
});

test("JSON-RPC stream notification sink does not wait for a slow consumer", async () => {
  const clientToServer = new PassThrough();
  const pendingWrites: Array<() => void> = [];
  const slowOutput = new Writable({
    highWaterMark: 1,
    write: (_chunk, _encoding, callback) => {
      pendingWrites.push(callback);
    }
  });
  let notify: ((notification: unknown) => void) | undefined;
  const connection = serveJsonRpcStream({
    input: clientToServer,
    output: slowOutput,
    transportKind: "unix-socket",
    authContext: { transportKind: "unix-socket" },
    createProtocolServer: (_authContext, _acceptedConnection, notificationSink) => {
      notify = notificationSink;
      return { handle: async () => undefined };
    }
  });

  for (let index = 0; index < 100; index += 1) {
    notify?.({ jsonrpc: "2.0", method: "repo.projection.changed", params: { sequence: index } });
  }
  assert.equal(pendingWrites.length, 1);
  assert.ok(slowOutput.writableLength > 1, `expected buffered notifications, saw ${slowOutput.writableLength} bytes`);

  while (pendingWrites.length > 0) pendingWrites.shift()?.();
  await connection.close();
});

function readFrame(input: Readable): Promise<unknown> {
  const lines = createInterface({ input });
  return new Promise((resolve) => lines.once("line", (line) => {
    lines.close();
    resolve(JSON.parse(line));
  }));
}
