// harness-test-tier: integration
import { scopedRpcParams } from "@harness-anything/daemon/protocol";
import assert from "node:assert/strict";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { signInAt } from "../../daemon/test/keycloak.fixtures.ts";
import { AccessAdminService } from "../../daemon/src/daemon-host/access-admin-service.ts";
import { createIdentitySession } from "../../daemon/src/daemon-host/authorization-provider.ts";
import { parseDaemonActionResponse, parseDaemonReadResult } from "@harness-anything/daemon/client";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { restoreEnv } from "./service-bridge.fixtures.ts";

test("GUI assignment carries the read version and preserves assignment through a held-lease refusal", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    daemonId: "gui-assignment",
    repoId: "gui-assignment",
    task: { taskId: "task-gui-assignment", title: "Assignment" },
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
    const bridge = createLocalGuiServiceBridge(),
      scope = { repoId: fixture.repoId, taskId: "task-gui-assignment" },
      read = async () => {
        const row = parseDaemonReadResult(
          "repo.tasks.list",
          await bridge.invoke("repo.tasks.list", scopedRpcParams("repo.tasks.list", { repoId: fixture.repoId })),
        ).rows.find((row) => row.taskId === scope.taskId)!;
        return { ...row.snapshot, assignmentRevision: row.assignmentRevision };
      };
    fixture.keycloak.revoke(
      "person-gui",
      fixture.repoId,
      effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
    );
    fixture.keycloak.permit(
      "person-gui",
      fixture.repoId,
      effectivePolicyGroupScopes(deriveBasePolicyGroups(), "maintainer"),
    );
    signInAt(fixture.userRoot, "person-gui", []);
    fixture.keycloak.node("node-assignment", "person-gui");
    const recipients = parseDaemonReadResult(
      "repo.tasks.assignmentDirectory",
      await bridge.invoke("repo.tasks.assignmentDirectory", scopedRpcParams("repo.tasks.assignmentDirectory", scope)),
    );
    assert.deepEqual(recipients.nodes, [{ nodeId: "node-assignment", personId: "person-gui" }]);
    assert.ok(recipients.people.some((person) => person.personId === "person-gui"));
    await assert.rejects(
      new AccessAdminService(createIdentitySession(fixture.userRoot), fixture.userRoot).run({
        operation: "node-list",
      }),
      /access-manage/,
    );
    fixture.keycloak.revoke("person-gui", fixture.repoId, ["task-assign"]);
    const deniedDirectory = await bridge.invoke(
      "repo.tasks.assignmentDirectory",
      scopedRpcParams("repo.tasks.assignmentDirectory", scope),
    );
    assert.match(JSON.stringify(deniedDirectory), /authorization_denied/);
    assert.equal("people" in deniedDirectory, false);
    fixture.keycloak.permit("person-gui", fixture.repoId, ["task-assign"]);
    const before = await read(),
      personId = before.task!.createdBy.principal.personId;
    const assigned = parseDaemonActionResponse(
      "repo.task.assign",
      await bridge.invoke(
        "repo.task.assign",
        scopedRpcParams("repo.task.assign", { ...scope, expectedVersion: before.assignmentRevision, personId }),
      ),
    );
    assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));
    const after = await read();
    assert.deepEqual(after.task!.assignment?.assignee, { kind: "person", personId });
    assert.ok(Date.parse(after.task!.assignment!.expiresAt) > Date.now() + 23 * 3600000);
    fixture.keycloak.revoke("person-gui", fixture.repoId, ["task-unassign"]);
    const deniedRemoval = parseDaemonActionResponse(
      "repo.task.unassign",
      await bridge.invoke(
        "repo.task.unassign",
        scopedRpcParams("repo.task.unassign", { ...scope, expectedVersion: after.assignmentRevision }),
      ),
    );
    assert.equal(deniedRemoval.outcome, "op_rejected");
    assert.equal(deniedRemoval.code, "authorization_denied");
    assert.equal(deniedRemoval.authorizationDecision?.outcome, "denied");
    assert.equal((await read()).revision, after.revision);
    assert.deepEqual((await read()).task!.assignment, after.task!.assignment);
    fixture.keycloak.permit("person-gui", fixture.repoId, ["task-unassign"]);
    const stale = parseDaemonActionResponse(
      "repo.task.unassign",
      await bridge.invoke(
        "repo.task.unassign",
        scopedRpcParams("repo.task.unassign", { ...scope, expectedVersion: before.assignmentRevision }),
      ),
    );
    assert.equal(stale.ok, false);
    assert.deepEqual((await read()).task!.assignment, after.task!.assignment);
    const removed = parseDaemonActionResponse(
      "repo.task.unassign",
      await bridge.invoke(
        "repo.task.unassign",
        scopedRpcParams("repo.task.unassign", { ...scope, expectedVersion: after.assignmentRevision }),
      ),
    );
    assert.equal(removed.outcome, "applied", JSON.stringify(removed));
    assert.equal((await read()).task!.assignment, null);
    const explicit = "2099-01-01T00:00:00.000Z";
    await bridge.invoke(
      "repo.task.assign",
      scopedRpcParams("repo.task.assign", {
        ...scope,
        expectedVersion: (await read()).assignmentRevision,
        personId,
        expiresAt: explicit,
      }),
    );
    assert.equal((await read()).task!.assignment!.expiresAt, explicit);
    const started = parseDaemonActionResponse(
      "repo.task.start",
      await bridge.invoke(
        "repo.task.start",
        scopedRpcParams("repo.task.start", { ...scope, executionId: "execution-gui-assignment" }),
      ),
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const held = parseDaemonActionResponse(
      "repo.task.unassign",
      await bridge.invoke(
        "repo.task.unassign",
        scopedRpcParams("repo.task.unassign", { ...scope, expectedVersion: (await read()).assignmentRevision }),
      ),
    );
    assert.equal(held.ok, false);
    assert.equal((await read()).task!.assignment!.expiresAt, explicit);
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    await fixture.stop();
  }
});
