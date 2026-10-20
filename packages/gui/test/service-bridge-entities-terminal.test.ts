// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { daemonGuiInvokeFacets, daemonGuiStreamFacets, jsonRpcMethodContracts } from "@harness-anything/daemon/client";
import { parseDaemonGuiActionResponse, parseDaemonGuiReadResult } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

import { restoreEnv } from "./service-bridge.fixtures.ts";
test("GUI entity write channel validates then installs an Agent and preserves a Squad roster", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task-gui-entity-write", title: "Entity write" },
    runtimeInstance: {
      instanceId: "codex-gui",
      name: "Codex GUI",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.6-terra"],
    },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  };
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId },
      agentDeclaration = {
        schema: "agent-declaration/v1",
        id: "gui-created-agent",
        name: "GUI Created Agent",
        instructions: "Keep the roster intact.\nSecond line.",
        runtimes: [{ type: "codex", model: "gpt-5.6-terra" }],
        instance: "codex-gui",
        role: "commander",
        skills: [{ id: "review", path: "skills/review" }],
        prompts: ["prompt://gui"],
        preset: "standard-task",
      };
    const agentReceipt = parseDaemonGuiActionResponse(
      "repo.agent.entity.write",
      await bridge.invoke("saveAgent", {
        ...scope,
        declaration: agentDeclaration,
      }),
    );
    assert.equal(agentReceipt.ok, true, JSON.stringify(agentReceipt));
    assert.equal(agentReceipt.outcome, "applied");
    const roster = "## GUI Squad\n\n  GUI Created Agent\n\n";
    const squadReceipt = parseDaemonGuiActionResponse(
      "repo.squad.entity.write",
      await bridge.invoke("saveSquad", {
        ...scope,
        declaration: {
          schema: "squad-declaration/v1",
          id: "gui-created-squad",
          name: "GUI Created Squad",
          leader: "gui-created-agent",
          workers: ["gui-created-agent"],
          leaderTurnBudget: 8,
          roster,
        },
      }),
    );
    assert.equal(squadReceipt.ok, true, JSON.stringify(squadReceipt));
    assert.equal(squadReceipt.outcome, "applied");
    for (const receipt of [agentReceipt, squadReceipt]) {
      const visible = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.read",
        {
          repo: scope,
          payload: {
            action: {
              kind: "receipt-show",
              opId: receipt.opId,
              waitFor: ["git_verified", "worktree_visible"],
              timeoutMs: 5000,
            },
          },
        },
        1000,
        10000,
      );
      assert.equal(visible.wait?.state, "satisfied", JSON.stringify(visible));
    }
    assert.equal(existsSync(path.join(fixture.rootDir, "harness/agents/gui-created-agent.json")), true);
    assert.equal(existsSync(path.join(fixture.rootDir, "harness/squads/gui-created-squad.json")), true);
    assert.equal(existsSync(path.join(fixture.rootDir, ".harness/agents")), false);
    assert.equal(existsSync(path.join(fixture.rootDir, ".harness/squads")), false);
    const listed = parseDaemonGuiReadResult("repo.agent.entities.list", await bridge.invoke("listAgents", scope));
    assert.ok(listed.agents.some(({ id }) => id === "gui-created-agent"));
    const shownAgent = parseDaemonGuiReadResult(
      "repo.agent.entity.read",
      await bridge.invoke("showAgent", {
        ...scope,
        agentId: "gui-created-agent",
      }),
    );
    assert.deepEqual(shownAgent.agent.runtimes, [{ type: "codex", model: "gpt-5.6-terra" }]);
    assert.equal(shownAgent.agent.role, "commander");
    const shown = parseDaemonGuiReadResult(
      "repo.squad.entity.read",
      await bridge.invoke("showSquad", {
        ...scope,
        squadId: "gui-created-squad",
      }),
    );
    assert.equal(shown.squad.roster, roster);
    const rejected = parseDaemonGuiActionResponse(
      "repo.agent.entity.write",
      await bridge.invoke("saveAgent", {
        ...scope,
        declaration: { ...agentDeclaration, id: "Bad ID" },
      }),
    );
    assert.equal(rejected.outcome, "op_rejected");
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI contract rejects any shipped bridge method missing from the daemon protocol", () => {
  const daemonMethods = new Set(jsonRpcMethodContracts.map(({ method }) => method));
  const missing = [...daemonGuiInvokeFacets, ...daemonGuiStreamFacets]
    .map(({ method }) => method)
    .filter((method) => !daemonMethods.has(method));
  assert.deepEqual(missing, []);
});

test("GUI entity channel retires and deletes declarations through the CLI's action path", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task-gui-entity-lifecycle", title: "Entity lifecycle" },
    runtimeInstance: {
      instanceId: "codex-gui",
      name: "Codex GUI",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.6-terra"],
    },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  };
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId },
      declaration = (id: string, name: string) => ({
        schema: "agent-declaration/v1",
        id,
        name,
        instructions: `Instructions for ${name}.`,
        runtimes: [{ type: "codex", model: "gpt-5.6-terra" }],
        instance: "codex-gui",
      });
    for (const [id, name] of [
      ["gui-lifecycle-agent", "GUI Lifecycle Agent"],
      ["gui-lifecycle-next", "GUI Lifecycle Successor"],
    ] as const) {
      const created = parseDaemonGuiActionResponse(
        "repo.agent.entity.write",
        await bridge.invoke("saveAgent", { ...scope, declaration: declaration(id, name) }),
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
    }
    const squadReceipt = parseDaemonGuiActionResponse(
      "repo.squad.entity.write",
      await bridge.invoke("saveSquad", {
        ...scope,
        declaration: {
          schema: "squad-declaration/v1",
          id: "gui-lifecycle-squad",
          name: "GUI Lifecycle Squad",
          leader: "gui-lifecycle-agent",
          workers: ["gui-lifecycle-agent"],
          leaderTurnBudget: 4,
          roster: "# Lifecycle\n",
        },
      }),
    );
    assert.equal(squadReceipt.outcome, "applied", JSON.stringify(squadReceipt));

    // 删除被引用的 Agent:daemon 的 agent_referenced 拒绝原样到达 GUI 通道(expected-version
    // 取 show 结果里的声明自身 revision——这正是本测试同时证明的字段)。
    const beforeRetire = parseDaemonGuiReadResult(
      "repo.agent.entity.read",
      await bridge.invoke("showAgent", { ...scope, agentId: "gui-lifecycle-agent" }),
    );
    assert.equal(Number.isSafeInteger(beforeRetire.agent.revision) && beforeRetire.agent.revision >= 1, true);
    const referencedDelete = parseDaemonGuiActionResponse(
      "repo.agent.entity.delete",
      await bridge.invoke("deleteAgent", {
        ...scope,
        agentId: "gui-lifecycle-agent",
        reason: "Attempt to delete a referenced agent.",
        expectedVersion: beforeRetire.agent.revision,
      }),
    );
    assert.equal(referencedDelete.outcome, "op_rejected", JSON.stringify(referencedDelete));
    assert.equal((referencedDelete as { readonly error?: { readonly code?: string } }).error?.code, "agent_referenced");

    // 退役:必填原因 + 可选接替者,走 agent-retire 同一条动作。
    const retired = parseDaemonGuiActionResponse(
      "repo.agent.entity.retire",
      await bridge.invoke("retireAgent", {
        ...scope,
        agentId: "gui-lifecycle-agent",
        reason: "Superseded by the successor agent.",
        successor: "gui-lifecycle-next",
      }),
    );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));

    // 退役后的读面:目录行与 detail 都带退役事实;重装被拒(agent_retired)。
    const listedAfterRetire = parseDaemonGuiReadResult(
      "repo.agent.entities.list",
      await bridge.invoke("listAgents", scope),
    );
    const retiredRow = listedAfterRetire.agents.find(({ id }) => id === "gui-lifecycle-agent");
    assert.deepEqual(retiredRow?.retirement, {
      retiredAt: (retiredRow?.retirement ?? {}).retiredAt,
      reason: "Superseded by the successor agent.",
      successor: "gui-lifecycle-next",
    });
    const shownAfterRetire = parseDaemonGuiReadResult(
      "repo.agent.entity.read",
      await bridge.invoke("showAgent", { ...scope, agentId: "gui-lifecycle-agent" }),
    );
    assert.equal(shownAfterRetire.agent.retirement?.successor, "gui-lifecycle-next");
    assert.equal(shownAfterRetire.agent.retirement?.reason, "Superseded by the successor agent.");
    const reinstall = parseDaemonGuiActionResponse(
      "repo.agent.entity.write",
      await bridge.invoke("saveAgent", {
        ...scope,
        declaration: declaration("gui-lifecycle-agent", "GUI Lifecycle Agent"),
      }),
    );
    assert.equal(reinstall.outcome, "op_rejected");
    assert.equal((reinstall as { readonly error?: { readonly code?: string } }).error?.code, "agent_retired");

    // 删除小队:stale revision 拒绝 revision_conflict,新 revision 删除成功。
    const squadShown = parseDaemonGuiReadResult(
      "repo.squad.entity.read",
      await bridge.invoke("showSquad", { ...scope, squadId: "gui-lifecycle-squad" }),
    );
    assert.equal(Number.isSafeInteger(squadShown.squad.revision) && squadShown.squad.revision >= 1, true);
    const staleSquadDelete = parseDaemonGuiActionResponse(
      "repo.squad.entity.delete",
      await bridge.invoke("deleteSquad", {
        ...scope,
        squadId: "gui-lifecycle-squad",
        reason: "Stale revision attempt.",
        expectedVersion: squadShown.squad.revision - 1,
      }),
    );
    assert.equal(staleSquadDelete.outcome, "op_rejected");
    assert.equal(
      (staleSquadDelete as { readonly error?: { readonly code?: string } }).error?.code,
      "revision_conflict",
    );
    const squadDeleted = parseDaemonGuiActionResponse(
      "repo.squad.entity.delete",
      await bridge.invoke("deleteSquad", {
        ...scope,
        squadId: "gui-lifecycle-squad",
        reason: "Retire the test squad current view.",
        expectedVersion: squadShown.squad.revision,
      }),
    );
    assert.equal(squadDeleted.outcome, "applied", JSON.stringify(squadDeleted));

    // 引用解除后删除退役 Agent:revision 用退役后的新值(退役事件推进了实体 revision)。
    const retiredAgentDeleted = parseDaemonGuiActionResponse(
      "repo.agent.entity.delete",
      await bridge.invoke("deleteAgent", {
        ...scope,
        agentId: "gui-lifecycle-agent",
        reason: "History retained; current view removed.",
        expectedVersion: shownAfterRetire.agent.revision,
      }),
    );
    assert.equal(retiredAgentDeleted.outcome, "applied", JSON.stringify(retiredAgentDeleted));
    const listedAfterDelete = parseDaemonGuiReadResult(
      "repo.agent.entities.list",
      await bridge.invoke("listAgents", scope),
    );
    assert.equal(
      listedAfterDelete.agents.some(({ id }) => id === "gui-lifecycle-agent"),
      false,
    );
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

test("GUI renderer bridge drives a resident PTY through spawn attach IO resize detach and terminate", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task-terminal", title: "Terminal renderer chain" },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  };
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId };
    const spawned = (await bridge.invoke("spawnTerminal", {
      ...scope,
      idempotencyKey: "terminal-renderer-chain",
      backend: "direct-pty",
      name: "Renderer chain",
      cwd: { scope: "repo-root" },
      shellProfileId: "default",
      taskId: "task-terminal",
    })) as Record<string, unknown>;
    assert.equal(spawned.schema, "terminal-control-receipt/v1", JSON.stringify(spawned));
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const sessionId = String(spawned.sessionId),
      values: Array<Record<string, unknown>> = [];
    let output = "",
      resolveEcho!: () => void;
    const echoSeen = new Promise<void>((resolve) => {
      resolveEcho = resolve;
    });
    const stop = await bridge.stream("attachTerminal", { ...scope, sessionId, afterSeq: 0 }, (value) => {
      const frame = value as Record<string, unknown>;
      values.push(frame);
      if (frame.schema === "terminal-attach-event/v1" && frame.kind === "output" && typeof frame.utf8 === "string") {
        output += frame.utf8;
        if (output.includes("GUI_S3_R2_PTY")) resolveEcho();
      }
    });
    const initial = values.find((value) => value.schema === "terminal-attach/v1");
    assert.equal(initial?.status, "attached");
    assert.equal(typeof initial?.attachmentId, "string");
    const input = (await bridge.invoke("sendTerminalInput", {
      ...scope,
      sessionId,
      clientSeq: 1,
      utf8: "echo GUI_S3_R2_PTY\r",
    })) as Record<string, unknown>;
    assert.deepEqual(
      { schema: input.schema, acceptedThrough: input.acceptedThrough },
      { schema: "terminal-input-ack/v1", acceptedThrough: 1 },
      JSON.stringify(input),
    );
    await Promise.race([
      echoSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("resident PTY echo timeout")), 2_000)),
    ]);
    const resized = (await bridge.invoke("resizeTerminal", {
      ...scope,
      sessionId,
      cols: 100,
      rows: 30,
    })) as Record<string, unknown>;
    assert.equal(resized.outcome, "applied", JSON.stringify(resized));
    const detached = (await bridge.invoke("detachTerminal", {
      ...scope,
      sessionId,
      attachmentId: initial!.attachmentId,
    })) as Record<string, unknown>;
    assert.deepEqual(
      { schema: detached.schema, state: detached.state },
      { schema: "terminal-detach-ack/v1", state: "detached" },
    );
    stop();
    const rejected = (await bridge.invoke("terminateTerminal", {
      ...scope,
      sessionId,
      confirmed: false,
    })) as Record<string, unknown>;
    assert.equal(rejected.outcome, "op_rejected");
    const terminated = (await bridge.invoke("terminateTerminal", {
      ...scope,
      sessionId,
      confirmed: true,
    })) as Record<string, unknown>;
    assert.deepEqual({ outcome: terminated.outcome, state: terminated.state }, { outcome: "applied", state: "exited" });
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});
