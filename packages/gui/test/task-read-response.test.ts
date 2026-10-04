// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { registerDaemonConnection, registerDaemonRepo } from "@harness-anything/kernel";
import { isolateDaemonTaskSnapshotRows } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { daemonProtocolError, localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

for (const code of ["repo_unavailable", "authorization_denied", "isolated rows"]) {
  test(`GUI task read preserves the ${code} receipt through a remote-proxy socket`, async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-task-response-")),
      socketPath = localUserDaemonEndpoint(parent, "task-response"),
      receipt =
        code === "isolated rows"
          ? {
              ok: true,
              status: "ready",
              watermark: 1,
              sourceRevision: 1,
              warnings: [],
              ...isolateDaemonTaskSnapshotRows([{ taskId: "task-invalid" }]),
            }
          : daemonProtocolError("repo.tasks.list", code, "Repository read rejected at the center."),
      previous = { root: process.env.HARNESS_DAEMON_USER_ROOT, id: process.env.HARNESS_DAEMON_ID },
      server = net.createServer((socket) => {
        createInterface({ input: socket }).on("line", (line) => {
          const request = JSON.parse(line);
          const result =
            request.method === "protocol.hello"
              ? { ok: true, methods: ["protocol.hello", "repo.tasks.list"] }
              : receipt;
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        });
      });
    const warn = t.mock.method(console, "warn", () => undefined);
    mkdirSync(path.dirname(socketPath), { recursive: true });
    registerDaemonConnection({ id: "center", endpoint: "tcp://127.0.0.1:19911", userRoot: parent });
    registerDaemonRepo({ repoId: "proxy-repo", mode: "remote-proxy", connectionId: "center", userRoot: parent });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.HARNESS_DAEMON_USER_ROOT = parent;
    process.env.HARNESS_DAEMON_ID = "task-response";
    try {
      assert.deepEqual(await createLocalGuiServiceBridge(parent).invoke("getTasks", { repoId: "proxy-repo" }), receipt);
      assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments),
        code === "isolated rows"
          ? [
              [
                "[repo.tasks.list] isolated invalid task snapshot row rowIndex=0 taskId=task-invalid field=rows[0].packagePath: actual=undefined: Task snapshot field is invalid.",
              ],
            ]
          : [],
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous.root === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
      else process.env.HARNESS_DAEMON_USER_ROOT = previous.root;
      if (previous.id === undefined) delete process.env.HARNESS_DAEMON_ID;
      else process.env.HARNESS_DAEMON_ID = previous.id;
      rmSync(parent, { recursive: true, force: true });
    }
  });
}
