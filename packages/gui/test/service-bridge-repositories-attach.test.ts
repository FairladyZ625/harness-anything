// harness-test-tier: integration
import assert from "node:assert/strict";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { parseDaemonGuiReadResult } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { readCatalogPreset } from "../src/renderer/api-client-catalog.ts";
import { startWorkPlan } from "../src/renderer/start-work-flow.ts";
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
    const bridge = createLocalGuiServiceBridge(fixture.rootDir);
    const [repoA, repoB] = await Promise.all([
      bridge.invoke("getTasks", { repoId: fixture.repoId }),
      bridge.invoke("getTasks", { repoId: repoBId }),
    ]);
    assert.deepEqual(
      parseDaemonGuiReadResult("repo.tasks.list", repoA).rows.map(({ taskId }) => taskId),
      ["task-gui-smoke", "task-repo-a"],
    );
    assert.deepEqual(
      parseDaemonGuiReadResult("repo.tasks.list", repoB).rows.map(({ taskId }) => taskId),
      ["task-repo-b"],
    );
    const [graphA, graphB, catalogA, catalogB] = await Promise.all([
      bridge.invoke("getRelationGraph", { repoId: fixture.repoId }),
      bridge.invoke("getRelationGraph", { repoId: repoBId }),
      bridge.invoke("getCatalogSnapshot", { repoId: fixture.repoId }),
      bridge.invoke("getCatalogSnapshot", { repoId: repoBId }),
    ]);
    assert.equal(parseDaemonGuiReadResult("repo.triadic.relationGraph", graphA).edges.length > 0, true);
    assert.equal(parseDaemonGuiReadResult("repo.triadic.relationGraph", graphB).edges.length, 0);
    assert.deepEqual(
      [(catalogA as { repoId: string }).repoId, (catalogB as { repoId: string }).repoId],
      [fixture.repoId, repoBId],
    );
    const system = parseDaemonGuiReadResult("daemon.gui.system.read", await bridge.invoke("getSystemStatus", null));
    assert.deepEqual(
      system.repos.map((repo) => [repo.repoId, repo.registrationState, repo.cellState]),
      [
        [fixture.repoId, "enabled", "attached"],
        [repoBId, "enabled", "attached"],
      ],
    );
    const unbound = await requestDaemonJsonRpcAt(fixture.endpoint, "daemon.repo.unbind", { repoId: repoBId }, 1_000);
    assert.equal(unbound.ok, true, JSON.stringify(unbound));
    const afterUnbind = parseDaemonGuiReadResult(
      "daemon.gui.system.read",
      await bridge.invoke("getSystemStatus", null),
    );
    assert.equal(
      afterUnbind.repos.find((repo) => repo.repoId === repoBId),
      undefined,
    );
    const denied = (await bridge.invoke("getTasks", {
      repoId: repoBId,
    })) as Failure;
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

test("GUI task creation uses the daemon Action authorization and system read matches ha daemon status", async () => {
  const fixture = await startGuiResidentDaemonFixture({ displayName: "GUI Task Create Probe" }),
    previous = {
      userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
      daemonId: process.env.HARNESS_DAEMON_ID,
      repoId: process.env.HARNESS_DAEMON_REPO_ID,
    };
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      detail = readCatalogPreset(
        await bridge.invoke("getCatalogPreset", { repoId: fixture.repoId, presetId: "standard-task" }),
      ),
      scaffold = detail.resolved.documents.find(({ slot }) => slot === "task.plan");
    assert.ok(scaffold, "the selected preset must provide a task.plan scaffold");
    const plan = startWorkPlan(
      scaffold.body,
      "Created from the GUI bridge",
      "Prove that the GUI action reaches the authorized daemon task-create path.",
      "Use the Brief above as the objective for this section.",
    );
    assert.ok(plan, "the selected preset scaffold must produce a task plan");
    const payload = {
        repoId: fixture.repoId,
        title: "Created from the GUI bridge",
        presetId: "standard-task",
        verticalId: "software/coding",
        locale: "en-US",
        riskTier: "medium",
        taskClass: "standard",
        workKind: "feat",
        idempotencyKey: "gui-bridge-task-create-positive",
        plan,
      },
      receipt = (await bridge.invoke("createTask", payload)) as Record<string, unknown>;
    assert.equal(receipt.schema, "command-receipt/v2", JSON.stringify(receipt));
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.command, "task-create", JSON.stringify(receipt));
    assert.ok(["applied", "pending", "no_changes"].includes(String(receipt.outcome)), JSON.stringify(receipt));
    assert.equal(typeof receipt.taskId, "string", JSON.stringify(receipt));
    assert.equal(typeof receipt.packagePath, "string", JSON.stringify(receipt));
    assert.equal(typeof receipt.opId, "string", JSON.stringify(receipt));

    fixture.keycloak.revoke("person-gui", fixture.repoId, ["task-create"]);
    const denied = (await bridge.invoke("createTask", {
      ...payload,
      title: "Denied from the GUI bridge",
      idempotencyKey: "gui-bridge-task-create-negative",
    })) as Record<string, unknown>;
    assert.equal(denied.schema, "command-receipt/v2", JSON.stringify(denied));
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
    assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));

    const system = parseDaemonGuiReadResult("daemon.gui.system.read", await bridge.invoke("getSystemStatus", null)),
      statusEnv = { ...process.env, ...fixture.env };
    delete statusEnv.HARNESS_DAEMON_ENDPOINT;
    delete statusEnv.HARNESS_DAEMON_RELAY;
    delete statusEnv.HARNESS_EXECUTION_CREDENTIAL;
    delete statusEnv.HARNESS_EXECUTION_EXPIRES_AT;
    const cliStatus = JSON.parse(
      execFileSync(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", fixture.rootDir, "--json", "daemon", "status"],
        { cwd: process.cwd(), env: statusEnv, encoding: "utf8" },
      ),
    ) as { readonly repos: readonly Record<string, unknown>[] };
    assert.deepEqual(
      system.repos.map(({ repoId, displayName, canonicalRoot, registrationState, cellState }) => {
        assert.equal(typeof displayName, "string");
        assert.equal(displayName, "GUI Task Create Probe");
        return [repoId, canonicalRoot, registrationState, cellState];
      }),
      cliStatus.repos.map(({ repoId, rootDir, registrationState, state }) => [
        repoId,
        rootDir === "" ? null : rootDir,
        registrationState ?? "enabled",
        state === "closed" ? "not_loaded" : state,
      ]),
    );
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("daemon runtime stream reconnects after transport loss from the last delivered cursor and accepts restart gap", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-runtime-reconnect-")),
    socketPath = localUserDaemonEndpoint(parent, "runtime-reconnect"),
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
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
            continue;
          }
          attempts.push(request.params.payload?.afterCursor ?? "missing");
          if (attempts.length === 1) {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, status: "attached", runtimeSessionId: "runtime-reconnect", cursor: "stream:0", events: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "repo.agentRuntime.attach.frame", params: { schema: "agent-runtime-attach-event/v1", type: "heartbeat", runtimeSessionId: "runtime-reconnect", cursor: "stream:1", occurredAt: "2026-08-13T00:00:00.000Z" } })}\n`,
              () => {
                socket.destroy();
                server.close(() => setTimeout(() => server.listen(socketPath), 120));
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
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
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
