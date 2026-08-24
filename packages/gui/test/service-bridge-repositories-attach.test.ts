// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { parseDaemonGuiReadResult } from "../../daemon/src/protocol/gui-result-validation.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { streamAgentRuntimeAt } from "../src/main/agent-runtime-stream-client.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import {
  seedTriadicEvents,
  writeTriadicLedger,
} from "../test-support/triadic-ledger.mjs";

import type { Failure } from "./service-bridge.fixtures.ts";
import { restoreEnv } from "./service-bridge.fixtures.ts";
test("GUI bridge switches between two enabled RepoCells without leaking task rows", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task-repo-a", title: "Repo A task" },
    beforeStop: async (endpoint, repoId) => {
      const created = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.create",
        {
          repo: { repoId },
          payload: { taskId: "task-gui-smoke", title: "Repo A triadic task" },
        },
        1_000,
      );
      assert.equal(created.ok, true, JSON.stringify(created));
    },
    beforeRestart: seedTriadicEvents,
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  };
  Object.assign(process.env, fixture.env);
  try {
    writeTriadicLedger(fixture.rootDir);
    const repoBRoot = path.join(path.dirname(fixture.rootDir), "repo-b"),
      repoBId = "gui-test-b";
    const bootstrapped = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.repo.bootstrap",
      {
        rootDir: repoBRoot,
        repoId: repoBId,
        personId: "person-gui",
        displayName: "GUI Test B",
      },
      1_000,
    );
    assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
    const created = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.create",
      {
        repo: { repoId: repoBId },
        payload: { taskId: "task-repo-b", title: "Repo B task" },
      },
      1_000,
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    const bridge = createLocalGuiServiceBridge(fixture.rootDir);
    const [repoA, repoB] = await Promise.all([
      bridge.invoke("getTasks", { repoId: fixture.repoId }),
      bridge.invoke("getTasks", { repoId: repoBId }),
    ]);
    assert.deepEqual(
      parseDaemonGuiReadResult("repo.tasks.list", repoA).rows.map(
        ({ taskId }) => taskId,
      ),
      ["task-gui-smoke", "task-repo-a"],
    );
    assert.deepEqual(
      parseDaemonGuiReadResult("repo.tasks.list", repoB).rows.map(
        ({ taskId }) => taskId,
      ),
      ["task-repo-b"],
    );
    const [graphA, graphB, catalogA, catalogB] = await Promise.all([
      bridge.invoke("getRelationGraph", { repoId: fixture.repoId }),
      bridge.invoke("getRelationGraph", { repoId: repoBId }),
      bridge.invoke("getCatalogSnapshot", { repoId: fixture.repoId }),
      bridge.invoke("getCatalogSnapshot", { repoId: repoBId }),
    ]);
    assert.equal(
      parseDaemonGuiReadResult("repo.triadic.relationGraph", graphA).edges
        .length > 0,
      true,
    );
    assert.equal(
      parseDaemonGuiReadResult("repo.triadic.relationGraph", graphB).edges
        .length,
      0,
    );
    assert.deepEqual(
      [
        (catalogA as { repoId: string }).repoId,
        (catalogB as { repoId: string }).repoId,
      ],
      [fixture.repoId, repoBId],
    );
    const system = parseDaemonGuiReadResult(
      "daemon.gui.system.read",
      await bridge.invoke("getSystemStatus", null),
    );
    assert.deepEqual(
      system.repos.map((repo) => [
        repo.repoId,
        repo.registrationState,
        repo.cellState,
      ]),
      [
        [fixture.repoId, "enabled", "attached"],
        [repoBId, "enabled", "attached"],
      ],
    );
    const disabled = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.repo.unregister",
      { repoId: repoBId },
      1_000,
    );
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    const afterDisable = parseDaemonGuiReadResult(
      "daemon.gui.system.read",
      await bridge.invoke("getSystemStatus", null),
    );
    assert.deepEqual(
      afterDisable.repos.find((repo) => repo.repoId === repoBId) && {
        registrationState: afterDisable.repos.find(
          (repo) => repo.repoId === repoBId,
        )?.registrationState,
        cellState: afterDisable.repos.find((repo) => repo.repoId === repoBId)
          ?.cellState,
      },
      { registrationState: "disabled", cellState: "not_loaded" },
    );
    const denied = (await bridge.invoke("getTasks", {
      repoId: repoBId,
    })) as Failure;
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, "daemon_unavailable");
    assert.match(denied.error?.hint ?? "", /workspace is not registered/u);
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI attach reconnects after transport loss from the last delivered cursor and accepts restart gap", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-runtime-reconnect-")),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\ha-gui-runtime-reconnect-${randomUUID()}`
        : path.join(parent, "daemon.sock"),
    attempts: string[] = [],
    values: unknown[] = [];
  let resolveGap!: () => void;
  const gapSeen = new Promise<void>((resolve) => {
      resolveGap = resolve;
    }),
    server = net.createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          const request = JSON.parse(line) as {
            id: number;
            method: string;
            params: { payload?: { afterCursor?: string } };
          };
          if (request.method === "protocol.hello") {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`,
            );
            continue;
          }
          attempts.push(request.params.payload?.afterCursor ?? "missing");
          if (attempts.length === 1) {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "attached", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "repo.agentRuntime.attach.frame", params: { schema: "agent-runtime-attach-event/v1", type: "heartbeat", runtimeSessionId: "runtime-reconnect", cursor: "stream:1", occurredAt: "2026-08-13T00:00:00.000Z" } })}\n`,
              () => {
                socket.destroy();
                server.close(() =>
                  setTimeout(() => server.listen(socketPath), 120),
                );
              },
            );
          } else {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "gap", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [{ schema: "agent-runtime-attach-event/v1", type: "gap", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", occurredAt: "2026-08-13T00:00:01.000Z", required: "snapshot" }] } })}\n`,
            );
          }
        }
      });
    });
  try {
    server.listen(socketPath);
    await once(server, "listening");
    const detach = await streamAgentRuntimeAt({
      socketPath,
      repoId: "runtime-reconnect",
      payload: {
        runtimeSessionId: "runtime-reconnect",
        afterCursor: "stream:0",
      },
      onValue: (value) => {
        values.push(value);
        if ("ok" in value && value.ok && value.status === "gap") resolveGap();
      },
      timeoutMs: 1_000,
    });
    await gapSeen;
    assert.deepEqual(attempts, ["stream:0", "stream:1"]);
    assert.equal((values.at(-1) as { status?: string }).status, "gap");
    detach();
  } finally {
    server.close();
    await once(server, "close");
    rmSync(parent, { recursive: true, force: true });
  }
});
