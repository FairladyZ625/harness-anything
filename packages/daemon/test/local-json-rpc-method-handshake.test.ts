// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";

type Request = { readonly id: number; readonly method: string };

test("the handshake rejects a requested method absent from the daemon method table", async () => {
  const seen: string[] = [];
  const server = await rpcServer((request) => {
    seen.push(request.method);
    return request.method === "protocol.hello"
      ? { result: { ok: true, methods: ["protocol.hello"], build: { commit: "daemon-old" } } }
      : { result: { ok: true } };
  });
  try {
    await assert.rejects(requestDaemonJsonRpcAt(server.socketPath, "repo.gui.new-read", {}, 2_000), (error) => {
      assert.equal((error as { readonly code?: string }).code, "daemon_method_unavailable");
      assert.equal(
        (error as Error).message,
        "Attached local daemon build daemon-old does not advertise requested method repo.gui.new-read.",
      );
      return true;
    });
    assert.deepEqual(seen, ["protocol.hello"], "the unavailable method must not be sent after preflight");
  } finally {
    server.close();
  }
});

test("daemon-only methods do not make the requested-method handshake fail", async () => {
  const server = await rpcServer((request) =>
    request.method === "protocol.hello"
      ? { result: { ok: true, methods: ["protocol.hello", "repo.gui.read", "daemon.extra"] } }
      : { result: { ok: true, value: "accepted" } },
  );
  try {
    assert.deepEqual(await requestDaemonJsonRpcAt(server.socketPath, "repo.gui.read", {}, 2_000), {
      ok: true,
      value: "accepted",
    });
  } finally {
    server.close();
  }
});

test("a JSON-RPC method-not-found response retains its protocol identity", async () => {
  const server = await rpcServer((request) =>
    request.method === "protocol.hello"
      ? { result: { ok: true } }
      : { error: { code: -32601, message: "Method not found" } },
  );
  try {
    await assert.rejects(requestDaemonJsonRpcAt(server.socketPath, "repo.legacy", {}, 2_000), (error) => {
      assert.equal((error as { readonly code?: string }).code, "method_not_found");
      assert.equal((error as { readonly rpcCode?: number }).rpcCode, -32601);
      assert.equal((error as Error).message, "Method not found");
      return true;
    });
  } finally {
    server.close();
  }
});

async function rpcServer(
  respond: (
    request: Request,
  ) =>
    | { readonly result: Record<string, unknown> }
    | { readonly error: { readonly code: number; readonly message: string } },
): Promise<{ readonly socketPath: string; readonly close: () => void }> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-method-handshake-")),
    socketPath = path.join(parent, "daemon.sock"),
    server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as Request;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...respond(request) })}\n`);
        }
      });
    });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: () => {
      server.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
