// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { requestLocalDaemonJsonRpcForTarget } from "../src/client/local-json-rpc-client.ts";

test("a request reaches a draining stale daemon and carries its build warning", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stale-schema-client-")),
    socketPath = localUserDaemonEndpoint(parent, "stale-schema-client"),
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
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const receipt = await requestLocalDaemonJsonRpcForTarget(
      { socketPath, reportStaleBuild: true },
      "repo.agentRuntime.spawn",
      { repo: { repoId: "alpha" }, payload: { agentId: "reviewer" } },
      2_000,
      5_000,
    );
    assert.equal(receipt.ok, true);
    assert.equal((receipt.daemonBuild as Record<string, unknown>).code, "daemon_build_stale");
    assert.deepEqual(methods, ["protocol.hello", "repo.agentRuntime.spawn"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(parent, { recursive: true, force: true });
  }
});
