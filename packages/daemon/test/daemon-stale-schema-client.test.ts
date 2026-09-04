// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpcForTarget } from "../src/client/local-json-rpc-client.ts";

test("a schema-sensitive request stops at a stale-build handshake with a named field", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stale-schema-client-")),
    socketPath = path.join(parent, "client.sock"),
    methods: string[] = [],
    server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { readonly id: number; readonly method: string };
          methods.push(request.method);
          const result =
            request.method === "protocol.hello"
              ? {
                  ok: true,
                  warning: {
                    code: "daemon_build_stale",
                    loadedBuildId: "build-a",
                    diskBuildId: "build-b",
                    liveRuntimeSessions: 2,
                    pendingWrites: 0,
                    attachingRepositories: 0,
                    message: "Loaded daemon build is stale and will exit after its work drains.",
                  },
                }
              : { ok: true };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const receipt = await requestLocalDaemonJsonRpcForTarget(
      { socketPath, reportStaleBuild: true, rejectStaleBuildField: "agentId" },
      "repo.agentRuntime.spawn",
      { repo: { repoId: "alpha" }, payload: { agentId: "reviewer" } },
      2_000,
      5_000,
    );
    assert.equal(receipt.code, "daemon_build_stale");
    assert.deepEqual(receipt.diagnostic, {
      kind: "validation",
      entity: "repo.agentRuntime.spawn",
      field: "agentId",
      actual: "loaded build build-a",
      expectation:
        "Daemon build must match disk build build-b before sending this field; wait for the stale daemon to drain, then retry",
    });
    assert.deepEqual(methods, ["protocol.hello"], "the incompatible payload must not reach the stale daemon");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(parent, { recursive: true, force: true });
  }
});
