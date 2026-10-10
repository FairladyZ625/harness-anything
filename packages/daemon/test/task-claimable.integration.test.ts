// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_SETTINGS_V1,
  REPLAY_TASK_GRAPH,
  type TaskAssignment,
  type TaskClaimScope,
  type TaskProjection,
} from "@harness-anything/kernel";
import { emptyTaskLifecycleSnapshot } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract";
import { readClaimableTasks } from "../src/task-claimable-read.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";

const now = "2026-10-03T12:00:00.000Z",
  expiresAt = "2026-10-04T12:00:00.000Z";
function row(taskId: string, assignment: TaskAssignment | null): ReturnType<TaskProjection["list"]>["rows"][number] {
  return {
    taskId,
    packagePath: `tasks/${taskId}`,
    generation: "v1",
    workspaceRevision: 1,
    createdAt: now,
    updatedAt: now,
    snapshot: {
      ...emptyTaskLifecycleSnapshot(),
      revision: 1,
      task: {
        schema: "task/v2",
        taskId,
        title: taskId,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 1,
        createdBy: { principal: { personId: "owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
        packageDisposition: "active",
        assignment,
      },
    },
  };
}

test("fresh claimable query applies three scopes, live membership, task permission and lease without writes", async (t) => {
  const realm = await serveKeycloak();
  t.after(() => realm.close());
  realm.keycloak.account("owner");
  const adapter = new KeycloakPolicyAdapter({
    url: realm.url,
    realm: "harness",
    resourceServerClientId: "harness-center",
  });
  await adapter.syncBasePolicy("center-token");
  await adapter.createTeam("center-token", "Builders");
  const team = (await adapter.readTeams("center-token"))[0]!,
    userId = (await adapter.findUserId("center-token", "owner"))!;
  await adapter.setTeamMember("center-token", team.id, userId, true);
  realm.keycloak.permit("owner", "repo", ["task-start"]);
  const rows = [
    row("task-node", { assignee: { kind: "person", personId: "owner", nodeId: "node-a" }, expiresAt }),
    row("task-other-node", { assignee: { kind: "person", personId: "owner", nodeId: "node-b" }, expiresAt }),
    row("task-person", { assignee: { kind: "person", personId: "owner" }, expiresAt }),
    row("task-team", { assignee: { kind: "team", teamId: team.id }, expiresAt }),
    row("task-free", null),
    row("task-expired", { assignee: { kind: "person", personId: "someone-else" }, expiresAt: now }),
  ];
  const binding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source: { kind: "node", nodeId: "node-a" } as const,
      keycloakAuthorization: {
        session: {
          personId: "owner",
          accessToken: "token-owner",
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
        },
        center: async () => ({
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
          accessToken: "center-token",
        }),
      },
    },
    page = async () => ({ status: "ready" as const, rows, watermark: 1, sourceRevision: 1, warnings: [] }),
    query = (scope: TaskClaimScope = INITIAL_SETTINGS_V1.fleet.claim.scope as TaskClaimScope) =>
      readClaimableTasks({
        repoId: "repo",
        binding,
        now,
        page,
        settings: { ...INITIAL_SETTINGS_V1, fleet: { ...INITIAL_SETTINGS_V1.fleet, claim: { scope } } },
      }),
    before = JSON.stringify(rows),
    writes = realm.keycloak.writes.length;
  assert.deepEqual(
    (await query()).tasks.map((task) => task.taskId),
    ["task-node"],
  );
  assert.deepEqual(
    (await query("reserved")).tasks.map((task) => task.taskId),
    ["task-node", "task-person", "task-team"],
  );
  assert.deepEqual(
    (await query("startable")).tasks.map((task) => task.taskId),
    ["task-node", "task-person", "task-team", "task-expired", "task-free"],
  );
  assert.equal(JSON.stringify(rows), before);
  assert.ok(realm.keycloak.writes.slice(writes).every((request) => request.endsWith("/policy/evaluate")));
  const free = rows.find((entry) => entry.taskId === "task-free")!;
  rows[rows.indexOf(free)] = {
    ...free,
    snapshot: {
      ...free.snapshot,
      lease: {
        schema: "lease/v1",
        taskId: free.taskId,
        executionId: "held-execution",
        actor: binding.actor,
        source: binding.source,
        phase: "held",
        expiresAt,
        ttlMs: 86400000,
        version: 1,
      },
    },
  };
  assert.equal(
    (await query("startable")).tasks.some((task) => task.taskId === free.taskId),
    false,
  );
  await adapter.setTeamMember("center-token", team.id, userId, false);
  assert.deepEqual(
    (await query("reserved")).tasks.map((task) => task.taskId),
    ["task-node", "task-person"],
  );
  realm.keycloak.revoke("owner", "repo", ["task-start"]);
  await assert.rejects(query(), { code: "authorization_denied" });
  await adapter.writeGrant(
    "center-token",
    { groupId: "contributor", resource: "repo:task/task-node", userIds: [userId] },
    ["task-start"],
  );
  assert.deepEqual(
    (await query("startable")).tasks.map((task) => task.taskId),
    ["task-node"],
  );
  await assert.rejects(
    readClaimableTasks({
      repoId: "repo",
      binding: { ...binding, source: "local" },
      now,
      page,
      settings: INITIAL_SETTINGS_V1,
    }),
    { code: "authentication_required" },
  );
  await realm.close();
  await assert.rejects(query());
});

test("live node authorization reads claim candidates under all configured scopes", { timeout: 60_000 }, async (t) => {
  const { fleetNodeClaimFixture } = await import("./fleet-node-claim.fixtures.ts");
  const f = await fleetNodeClaimFixture(t);
  const query = (nodeId = "node-one") =>
    f.host.read("lease-repo", "repo.tasks.claimable", {}, f.owners.auth({ nodeId }));
  const revisions = new Map<string, number>();
  for (const suffix of ["named", "person", "free"]) {
    const created = await f.command("node-one", { kind: "task-create", taskId: `task-${suffix}`, title: suffix });
    assert.equal(created.outcome, "applied");
    revisions.set(`task-${suffix}`, Number(created.receipt?.projection?.revision ?? created.revision ?? 1));
  }
  for (const [suffix, target] of [
    ["named", { nodeId: "node-one" }],
    ["person", { personId: "person-one" }],
  ] as const) {
    assert.equal(
      (
        await f.command("node-one", {
          kind: "task-assign",
          taskId: `task-${suffix}`,
          expectedVersion: revisions.get(`task-${suffix}`),
          ...target,
        })
      ).outcome,
      "applied",
    );
  }
  const ids = (result: Record<string, unknown>) => (result.tasks as { taskId: string }[]).map((task) => task.taskId);
  assert.deepEqual(ids(await query()), ["task-named"]);
  assert.deepEqual(ids(await query("node-two")), []);
  for (const [scope, expected] of [
    ["reserved", ["task-named", "task-person"]],
    ["startable", ["task-named", "task-person", "task-free"]],
  ] as const) {
    const changed = await f.command("node-one", { kind: "settings-update", fleetClaimScope: scope });
    assert.equal(changed.outcome, "applied", JSON.stringify(changed));
    const before = f.eventCount();
    assert.deepEqual(ids(await query()), expected);
    assert.equal(f.eventCount(), before, "candidate reads append no accepted write");
  }
  assert.equal((await f.command("center-node", { kind: "task-start", taskId: "task-free" })).outcome, "applied");
  assert.deepEqual(ids(await query()), ["task-named", "task-person"]);
  f.owners.keycloak.revoke("person-one", "lease-repo", ["task-start"]);
  await assert.rejects(query(), /permission|denied/i);
});

test("task show states the expected-version assign accepts", { timeout: 60_000 }, async (t) => {
  const { fleetNodeClaimFixture } = await import("./fleet-node-claim.fixtures.ts");
  const { localAuthFixture } = await import("./fleet-runtime-recovery.fixtures.ts");
  const f = await fleetNodeClaimFixture(t);
  const taskId = "task-show-version";
  assert.equal(
    (await f.command("node-one", { kind: "task-create", taskId, title: "expected version visibility" })).outcome,
    "applied",
  );
  // task-show is a center read, not a fleet-forwardable write, so the node reads it off the host.
  const shown = (await f.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture())) as {
    readonly revision: number;
    readonly expectedVersion?: number;
    readonly evidence: string;
  };
  const snapshot = JSON.parse(shown.evidence) as { readonly revision: number };
  // The receipt states the task's own projection revision at the top level — the exact value
  // --expected-version validates — and it is not the ledger cut sitting beside it.
  assert.equal(shown.expectedVersion, snapshot.revision);
  assert.notEqual(shown.expectedVersion, shown.revision);
  t.diagnostic(
    `task-show ${taskId}: revision=${String(shown.revision)} (ledger cut) ` +
      `expectedVersion=${String(shown.expectedVersion)} (task projection revision)`,
  );
  // Sending the ledger cut (the pre-fix trap: the only revision visible at top level) is rejected;
  // sending the stated expectedVersion assigns.
  const rejected = await f.command("node-one", {
    kind: "task-assign",
    taskId,
    expectedVersion: shown.revision,
    nodeId: "node-one",
  });
  assert.equal(rejected.outcome, "op_rejected");
  t.diagnostic(
    `task-assign --expected-version ${String(shown.revision)} (ledger cut): ` +
      `${rejected.outcome} code=${String(rejected.code)}`,
  );
  const assigned = await f.command("node-one", {
    kind: "task-assign",
    taskId,
    expectedVersion: shown.expectedVersion,
    nodeId: "node-one",
  });
  assert.equal(assigned.outcome, "applied");
  t.diagnostic(`task-assign --expected-version ${String(shown.expectedVersion)}: ${assigned.outcome}`);
});
