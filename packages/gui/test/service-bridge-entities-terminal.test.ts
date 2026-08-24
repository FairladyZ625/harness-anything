// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  daemonGuiInvokeFacets,
  daemonGuiStreamFacets,
  jsonRpcMethodContracts,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  parseDaemonGuiActionResponse,
  parseDaemonGuiReadResult,
} from "../../daemon/src/protocol/gui-result-validation.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

import { restoreEnv } from "./service-bridge.fixtures.ts";
test("GUI entity write channel validates then installs an Agent and preserves a Squad roster", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task-gui-entity-write", title: "Entity write" },
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
        runtime_type: "any",
        role: "commander",
        model: "gpt-5.6-terra",
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
          roster,
        },
      }),
    );
    assert.equal(squadReceipt.ok, true, JSON.stringify(squadReceipt));
    assert.equal(squadReceipt.outcome, "applied");
    assert.equal(
      existsSync(
        path.join(fixture.rootDir, "harness/agents/gui-created-agent.json"),
      ),
      true,
    );
    assert.equal(
      existsSync(
        path.join(fixture.rootDir, "harness/squads/gui-created-squad.json"),
      ),
      true,
    );
    assert.equal(
      existsSync(path.join(fixture.rootDir, ".harness/agents")),
      false,
    );
    assert.equal(
      existsSync(path.join(fixture.rootDir, ".harness/squads")),
      false,
    );
    const listed = parseDaemonGuiReadResult(
      "repo.agent.entities.list",
      await bridge.invoke("listAgents", scope),
    );
    assert.ok(listed.agents.some(({ id }) => id === "gui-created-agent"));
    const shownAgent = parseDaemonGuiReadResult(
      "repo.agent.entity.read",
      await bridge.invoke("showAgent", {
        ...scope,
        agentId: "gui-created-agent",
      }),
    );
    assert.equal(shownAgent.agent.model, "gpt-5.6-terra");
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
  const daemonMethods = new Set(
    jsonRpcMethodContracts.map(({ method }) => method),
  );
  const missing = [...daemonGuiInvokeFacets, ...daemonGuiStreamFacets]
    .map(({ method }) => method)
    .filter((method) => !daemonMethods.has(method));
  assert.deepEqual(missing, []);
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
    assert.equal(
      spawned.schema,
      "terminal-control-receipt/v1",
      JSON.stringify(spawned),
    );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const sessionId = String(spawned.sessionId),
      values: Array<Record<string, unknown>> = [];
    let output = "",
      resolveEcho!: () => void;
    const echoSeen = new Promise<void>((resolve) => {
      resolveEcho = resolve;
    });
    const stop = await bridge.stream(
      "attachTerminal",
      { ...scope, sessionId, afterSeq: 0 },
      (value) => {
        const frame = value as Record<string, unknown>;
        values.push(frame);
        if (
          frame.schema === "terminal-attach-event/v1" &&
          frame.kind === "output" &&
          typeof frame.utf8 === "string"
        ) {
          output += frame.utf8;
          if (output.includes("GUI_S3_R2_PTY")) resolveEcho();
        }
      },
    );
    const initial = values.find(
      (value) => value.schema === "terminal-attach/v1",
    );
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
    );
    await Promise.race([
      echoSeen,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("resident PTY echo timeout")), 2_000),
      ),
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
    assert.deepEqual(
      { outcome: terminated.outcome, state: terminated.state },
      { outcome: "applied", state: "exited" },
    );
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});
