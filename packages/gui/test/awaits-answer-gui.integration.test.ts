// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonGuiActionResponse, parseDaemonGuiReadResult } from "@harness-anything/daemon/client";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { restoreEnv } from "./service-bridge.fixtures.ts";

/**
 * GUI 就地答复的端到端判据:渲染层经受控 preload 面发出的 retireRelation 落在与
 * `ha relation unrelate` 相同的 daemon 写路上——答复进 retire 理由,条目离开「等你答复」,
 * 源实体归属人的「已答复,待你跟进」出现同一条答复;过期修订被拒为 revision_conflict。
 */
test("GUI answers an awaits ask through the resident daemon write path", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    daemonId: "gui-awaits-answer",
    repoId: "gui-awaits",
    task: { taskId: "task-gui-awaits", title: "Awaits answer task" },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
  };
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  Object.assign(process.env, fixture.env);
  try {
    const added = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.run",
      {
        repo: { repoId: fixture.repoId },
        payload: {
          action: {
            kind: "people-add",
            personId: "person-reviewer",
            displayName: "GUI Reviewer",
            role: "administrator",
            commandClass: ["admin"],
            credentialKind: "email-address",
            credentialIssuer: "example.invalid",
            credentialSubject: "reviewer@example.invalid",
          },
        },
      },
      1_000,
    );
    assert.equal(added.ok, true, JSON.stringify(added));
    // 人员名册经发布进投影后,person/<id> 才是可被 relate 的目标(含 bootstrap 的 person-gui)。
    const published = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.read",
      {
        repo: { repoId: fixture.repoId },
        payload: {
          action: { kind: "receipt-show", opId: added.opId, waitFor: ["worktree_visible"], timeoutMs: 5000 },
        },
      },
      1_000,
      10_000,
    );
    assert.equal(published.wait?.state, "satisfied", JSON.stringify(published));
    const related = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.run",
      {
        repo: { repoId: fixture.repoId },
        payload: {
          action: {
            kind: "relation-relate",
            sourceRef: "task/task-gui-awaits",
            targetRef: "person/person-gui",
            relationType: "awaits",
            rationale: "acceptance: 请上手验收总览页",
            expectedVersion: 0,
          },
        },
      },
      1_000,
    );
    assert.equal(related.ok, true, JSON.stringify(related));
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId },
      agenda = async () => parseDaemonGuiReadResult("repo.agenda.read", await bridge.invoke("getAgenda", scope));
    const asked = await agenda(),
      row = asked.awaitingYou.find((candidate) => candidate.sourceRef === "task/task-gui-awaits");
    assert.ok(row, JSON.stringify(asked.awaitingYou));
    assert.equal(row.askKind, "acceptance");

    const stale = parseDaemonGuiActionResponse(
      "repo.relation.unrelate",
      await bridge.invoke("retireRelation", {
        ...scope,
        relationId: row.relationId,
        reason: "通过",
        expectedVersion: row.relationRevision - 1,
      }),
    );
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal((stale as { code?: string }).code, "revision_conflict", JSON.stringify(stale));

    const answered = parseDaemonGuiActionResponse(
      "repo.relation.unrelate",
      await bridge.invoke("retireRelation", {
        ...scope,
        relationId: row.relationId,
        reason: "不通过:按钮错位",
        expectedVersion: row.relationRevision,
      }),
    );
    assert.equal(answered.ok, true, JSON.stringify(answered));
    const after = await agenda();
    assert.deepEqual(after.awaitingYou, []);
    assert.deepEqual(
      after.answeredForYou.map(({ relationId, askKind, question, answer }) => ({
        relationId,
        askKind,
        question,
        answer,
      })),
      [{ relationId: row.relationId, askKind: "acceptance", question: "请上手验收总览页", answer: "不通过:按钮错位" }],
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    await fixture.stop();
  }
});
