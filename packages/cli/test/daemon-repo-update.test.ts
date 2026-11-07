// harness-test-tier: fast
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { runDaemonRepoControl } from "../src/daemon/repo-control.ts";

test("daemon repo update sends --root as a workspace root migration", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-repo-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userRoot = path.join(root, "user"),
    socketPath = localUserDaemonEndpoint(userRoot),
    requests: Array<{ readonly method: string; readonly params?: Record<string, unknown> }> = [],
    server = createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as {
          readonly id: number;
          readonly method: string;
          readonly params?: Record<string, unknown>;
        };
        requests.push(request);
        const result =
          request.method === "protocol.hello"
            ? fixtureDaemonHello()
            : { ok: true, command: "daemon-repo-update", outcome: "applied" };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      });
      socket.on("close", () => lines.close());
    });
  mkdirSync(path.dirname(socketPath), { recursive: true });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => server.close());

  const nextRoot = path.join(root, "new-workspace"),
    receipts: Record<string, unknown>[] = [],
    exitCode = await runDaemonRepoControl(
      ["--repo-id", "edge", "--root", nextRoot],
      "update",
      userRoot,
      "default",
      (receipt) => {
        receipts.push(receipt);
        return 0;
      },
    );

  assert.equal(exitCode, 0);
  assert.equal(receipts[0]?.ok, true);
  assert.deepEqual(requests.at(-1), {
    id: 2,
    jsonrpc: "2.0",
    method: "daemon.repo.update",
    params: { repoId: "edge", rootDir: path.resolve(nextRoot) },
  });
});
