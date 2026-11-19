// harness-test-tier: integration
import { emptyRuntimeSnapshot, runtimeCursor } from "../../daemon/test/fixtures/runtime-stream.ts";
import { scopedRpcParams } from "@harness-anything/daemon/protocol";
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import assert from "node:assert/strict";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { parseDaemonReadResult } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { streamAgentRuntimeAt } from "@harness-anything/daemon/client";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { seedTriadicEvents, seedTriadicReviewAwait, writeTriadicLedger } from "../test-support/triadic-ledger.mjs";

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
    afterRestart: seedTriadicReviewAwait,
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
    fixture.keycloak.permit("person-gui", repoBId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    const bootstrapped = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.repo.bootstrap",
      {
        rootDir: repoBRoot,
        repoId: repoBId,
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
    const bridge = createLocalGuiServiceBridge();
    const [repoA, repoB] = await Promise.all([
      bridge.invoke("repo.tasks.list", scopedRpcParams("repo.tasks.list", { repoId: fixture.repoId })),
      bridge.invoke("repo.tasks.list", scopedRpcParams("repo.tasks.list", { repoId: repoBId })),
    ]);
    assert.deepEqual(
      parseDaemonReadResult("repo.tasks.list", repoA).rows.map(({ taskId }) => taskId),
      ["task-gui-smoke", "task-repo-a"],
    );
    assert.deepEqual(
      parseDaemonReadResult("repo.tasks.list", repoB).rows.map(({ taskId }) => taskId),
      ["task-repo-b"],
    );
    const [graphA, graphB, catalogA, catalogB] = await Promise.all([
      bridge.invoke(
        "repo.triadic.relationGraph",
        scopedRpcParams("repo.triadic.relationGraph", { repoId: fixture.repoId }),
      ),
      bridge.invoke("repo.triadic.relationGraph", scopedRpcParams("repo.triadic.relationGraph", { repoId: repoBId })),
      bridge.invoke(
        "repo.gui.catalog.snapshot",
        scopedRpcParams("repo.gui.catalog.snapshot", { repoId: fixture.repoId }),
      ),
      bridge.invoke("repo.gui.catalog.snapshot", scopedRpcParams("repo.gui.catalog.snapshot", { repoId: repoBId })),
    ]);
    assert.equal(parseDaemonReadResult("repo.triadic.relationGraph", graphA).edges.length > 0, true);
    assert.equal(parseDaemonReadResult("repo.triadic.relationGraph", graphB).edges.length, 0);
    assert.deepEqual(
      [(catalogA as { repoId: string }).repoId, (catalogB as { repoId: string }).repoId],
      [fixture.repoId, repoBId],
    );
    const system = parseDaemonReadResult(
      "daemon.gui.system.read",
      await bridge.invoke("daemon.gui.system.read", scopedRpcParams("daemon.gui.system.read", {})),
    );
    assert.deepEqual(
      system.repos.map((repo) => [repo.repoId, repo.registrationState, repo.cellState]),
      [
        [fixture.repoId, "enabled", "attached"],
        [repoBId, "enabled", "attached"],
      ],
    );
    const unbound = await requestDaemonJsonRpcAt(fixture.endpoint, "daemon.repo.unbind", { repoId: repoBId }, 1_000);
    assert.equal(unbound.ok, true, JSON.stringify(unbound));
    const afterUnbind = parseDaemonReadResult(
      "daemon.gui.system.read",
      await bridge.invoke("daemon.gui.system.read", scopedRpcParams("daemon.gui.system.read", {})),
    );
    assert.equal(
      afterUnbind.repos.find((repo) => repo.repoId === repoBId),
      undefined,
    );
    const denied = (await bridge.invoke(
      "repo.tasks.list",
      scopedRpcParams("repo.tasks.list", {
        repoId: repoBId,
      }),
    )) as Failure;
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "workspace_not_registered");
    assert.match(denied.error.hint ?? "", /ha daemon repo register/u);
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test(
  "daemon runtime stream reconnects after transport loss from the last delivered cursor and accepts restart gap",
  { timeout: 30_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-runtime-reconnect-")),
      socketPath = localUserDaemonEndpoint(parent, "runtime-reconnect"),
      attempts: unknown[] = [],
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
              params: { payload?: { afterCursor?: ReturnType<typeof runtimeCursor> } };
            };
            if (request.method === "protocol.hello") {
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: fixtureDaemonHello() })}\n`);
              continue;
            }
            attempts.push(request.params.payload?.afterCursor ?? "missing");
            if (attempts.length === 1) {
              socket.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "attached", runtimeSessionId: "runtime-reconnect", cursor: runtimeCursor("runtime-reconnect", 0), events: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "repo.agentRuntime.attach.frame", params: { schema: "agent-runtime-attach-event/v2", type: "heartbeat", runtimeSessionId: "runtime-reconnect", cursor: runtimeCursor("runtime-reconnect", 1), occurredAt: "2026-08-13T00:00:00.000Z" } })}\n`,
                // The first connection drops after sending a heartbeat. The next connection
                // represents a restarted stream authority that cannot replay the old cursor.
                () => socket.destroy(),
              );
            } else {
              socket.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "gap", runtimeSessionId: "runtime-reconnect", cursor: runtimeCursor("runtime-reconnect", 0, "fresh-epoch"), events: [{ schema: "agent-runtime-attach-event/v2", type: "gap", runtimeSessionId: "runtime-reconnect", cursor: runtimeCursor("runtime-reconnect", 0, "fresh-epoch"), occurredAt: "2026-08-13T00:00:01.000Z", snapshotSeq: 0, snapshot: emptyRuntimeSnapshot }] } })}\n`,
              );
            }
          }
        });
      });
    let detach: (() => void) | undefined;
    try {
      mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      server.listen(socketPath);
      await once(server, "listening");
      detach = await streamAgentRuntimeAt({
        socketPath,
        repoId: "runtime-reconnect",
        payload: {
          runtimeSessionId: "runtime-reconnect",
        },
        onValue: (value) => {
          values.push(value);
          if ("ok" in value && value.ok && value.status === "gap") resolveGap();
        },
        timeoutMs: 1_000,
      });
      await gapSeen;
      assert.deepEqual(attempts, ["missing", runtimeCursor("runtime-reconnect", 1)]);
      assert.equal((values.at(-1) as { status?: string }).status, "gap");
    } finally {
      detach?.();
      server.close();
      await once(server, "close");
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
