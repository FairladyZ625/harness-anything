// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { startGuiResidentDaemonFixture } from "../../gui/test-support/resident-daemon.mjs";
import { seedBuiltinSidebar } from "../../../tools/gui-e2e/scenarios/builtin-sidebar-seed.mjs";

test(
  "builtin owner reads the actual work, agenda, policy and assignment directory through daemon RPC",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await startGuiResidentDaemonFixture({
      identityProvider: "builtin",
      prefix: "ha-builtin-reads-",
      task: { taskId: "task-builtin", title: "Builtin task" },
    });
    t.after(() => fixture.stop());
    const { workId } = await seedBuiltinSidebar(fixture);
    const read = (method: string, payload?: Record<string, unknown>) =>
      requestDaemonJsonRpcAt(
        fixture.endpoint,
        method,
        { repo: { repoId: fixture.repoId }, ...(payload ? { payload } : {}) },
        1_000,
        15_000,
      );
    const briefs = await read("repo.works.briefs.read");
    assert.equal(briefs.ok, true, JSON.stringify(briefs));
    assert.ok(JSON.stringify(briefs.briefs).includes(workId));
    assert.ok(JSON.stringify(briefs.briefs).includes("Builtin child task"));
    const agenda = await read("repo.agenda.read", {});
    assert.equal(agenda.ok, true, JSON.stringify(agenda));
    const directory = await read("repo.tasks.assignmentDirectory", { taskId: "task-builtin" });
    assert.deepEqual(directory.people, [{ personId: "person-gui", username: "owner" }]);
    assert.deepEqual(directory.teams, []);
    assert.deepEqual(directory.nodes, []);
    const policy = await read("repo.policy.metadata.read");
    assert.equal(policy.ok, true, JSON.stringify(policy));
    assert.ok(JSON.stringify(policy.groups).includes("admin"));
    const unsupported = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.rbac.manage",
      { operation: "team-create", teamName: "Other people", operationId: "team-create-negative" },
      1000,
      15000,
    );
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, "identity_plugin_required");
  },
);
