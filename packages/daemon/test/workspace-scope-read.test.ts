// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceScopeFromProjection } from "../src/workspace-scope-read.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "work" = "standard",
  packageDisposition: "active" | "archived" = "active",
  supersededBy: string | null = null,
) => ({
  taskId,
  parentTaskId,
  status,
  taskClass,
  title: taskId,
  pinned: taskId === "root",
  workKind: null,
  riskTier: null,
  urgency: null,
  packageDisposition,
  supersededBy,
  packagePath: `harness/tasks/${taskId}`,
  updatedAt: "2026-09-20T00:00:00.000Z",
});

const projection = (rows: readonly ReturnType<typeof task>[], events: readonly Record<string, unknown>[] = []) =>
  ({
    readTaskIndex: () => ({ status: "ready", rows, watermark: 12, sourceRevision: 12, warnings: [] }),
    readEventSummaries: (afterRevision: number, limit: number, scope: { taskIds: string[] }) => ({
      status: "ready",
      events: events
        .filter(
          (event) => Number(event.workspaceRevision) > afterRevision && scope.taskIds.includes(String(event.taskId)),
        )
        .slice(-limit),
      hasMore: false,
      watermark: events.at(-1)?.workspaceRevision ?? 0,
      sourceRevision: events.at(-1)?.workspaceRevision ?? 0,
    }),
  }) as never;

test("workspace scope counts only executable leaves and keeps cancellation separate", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("group", "root", "active", "work"),
    task("doing", "group", "active"),
    task("done", "root", "done"),
    task("cancelled", "root", "cancelled", "standard", "archived"),
    task("outside", null, "done"),
  ];
  const result = workspaceScopeFromProjection(projection(rows), { rootTaskId: "root", limit: 2 });

  assert.deepEqual(result.counts, { done: 1, executing: 1, pending: 0, blocked: 0, planned: 0, cancelled: 1 });
  assert.equal(result.scope.descendantCount, 4);
  assert.equal(result.scope.executableLeafCount, 3);
  assert.equal(result.scope.archivedCount, 1);
  assert.deepEqual(
    result.groups.map(({ taskId }) => taskId),
    ["group"],
  );
  assert.deepEqual(
    result.tasks.map(({ taskId }) => taskId),
    ["cancelled", "doing"],
  );
  assert.equal(result.page.nextCursor, "doing");
  assert.deepEqual(result.memberTaskIds, ["cancelled", "doing", "done", "group"]);
});

test("workspace scope counts a superseded terminal leaf as cancelled and keeps history totals", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("live", "root", "planned"),
    task("archived-only", "root", "planned", "standard", "archived"),
    task("retired", "root", "cancelled", "standard", "archived", "task_replacement"),
  ];
  const result = workspaceScopeFromProjection(projection(rows), { rootTaskId: "root" });

  assert.deepEqual(result.counts, { done: 0, executing: 0, pending: 0, blocked: 0, planned: 2, cancelled: 1 });
  assert.deepEqual(
    result.tasks.map(({ taskId }) => taskId),
    ["archived-only", "live", "retired"],
  );
  assert.deepEqual(result.memberTaskIds, ["archived-only", "live", "retired"]);
  assert.equal(result.scope.descendantCount, 3);
  assert.equal(result.scope.executableLeafCount, 3);
  assert.equal(result.scope.archivedCount, 2);
});

test("workspace scope reports a missing ancestor instead of inventing a breadcrumb", () => {
  const result = workspaceScopeFromProjection(
    {
      readTaskIndex: () => ({
        status: "pending",
        rows: [task("root", "missing", "planned", "work")],
        watermark: 8,
        sourceRevision: 9,
        warnings: ["projection_missing"],
      }),
      readEventSummaries: () => ({ status: "pending", events: [], watermark: 0, sourceRevision: 0 }),
    } as never,
    { rootTaskId: "root" },
  );
  assert.deepEqual(result.incompleteParentRefs, ["missing"]);
  assert.equal(result.status, "pending");
  assert.deepEqual(result.ancestors, []);
});

test("workspace scope cursor drains mixed-case task ids in sort order", () => {
  const rows = [
    task("root", null, "active", "work"),
    task("task_A", "root", "planned"),
    task("task_a", "root", "planned"),
  ];
  const source = projection(rows);
  const taskIds: string[] = [];
  let cursor: string | undefined;

  do {
    const page = workspaceScopeFromProjection(source, {
      rootTaskId: "root",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    taskIds.push(...page.tasks.map(({ taskId }) => taskId));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  assert.deepEqual(taskIds, ["task_a", "task_A"]);
});

test("workspace scope filters projected summaries by membership", () => {
  const rows = [task("root", null, "active", "work"), task("member", "root", "active")],
    events = [
      {
        eventId: "outside",
        schema: "ci-run-observation-event/v3",
        type: "ci_run_observed",
        occurredAt: "2026-09-20T00:00:00.000Z",
        workspaceRevision: 1,
        taskId: "outside",
        summary: "outside",
      },
      {
        eventId: "inside",
        schema: "ci-run-observation-event/v3",
        type: "ci_run_observed",
        occurredAt: "2026-09-20T00:01:00.000Z",
        workspaceRevision: 2,
        taskId: "member",
        summary: "inside",
      },
    ];
  const result = workspaceScopeFromProjection(projection(rows, events), { rootTaskId: "root" });

  assert.equal(result.eventSummaries.length, 1);
  assert.equal(result.eventSummaries[0]?.eventId, "inside");
  assert.equal(JSON.stringify(result.eventSummaries).includes("test-2406"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result.eventSummaries)) < 2_000);
});

// PG pagination is consumed by the daemon's claimable surface; keep this cross-package
// integration at the delivery layer, not in storage's inward-only tests.
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import {
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle.contract.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { createPgTaskProjectionSource } from "../../storage/src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../storage/src/postgres/transaction.ts";
test("PG claimable paging includes a preferred candidate after 500 rows", async () => {
  const { readClaimableTasks } = await import("../src/task-claimable-read.ts");
  const { serveKeycloak } = await import("./keycloak.fixtures.ts");
  const { KeycloakPolicyAdapter } = await import("@harness-anything/authorization-keycloak");
  const { INITIAL_SETTINGS_V1, assignmentRationale } = await import("@harness-anything/kernel");
  const fixture = await pgRuntimeFixture(),
    realm = await serveKeycloak();
  try {
    realm.keycloak.account("owner");
    const adapter = new KeycloakPolicyAdapter({
      url: realm.url,
      realm: "harness",
      resourceServerClientId: "harness-center",
    });
    await adapter.syncBasePolicy("center-token");
    realm.keycloak.permit("owner", "claimable", ["task-start"]);
    const scope = { tenantId: "claimable", projectId: "claimable", policyEpoch: 1 };
    const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
    const snapshot = reduceTaskEvent(emptyTaskLifecycleSnapshot(), lifecycleFixture().events[0]!);
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,'claimable',1,'fixture','fixture','fixture')`,
          keys,
        );
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,5,1,1)`,
          keys,
        );
        await client.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
        SELECT $1,$2,$3,'candidate-'||lpad(n::text,4,'0'),1,
          jsonb_set($4::jsonb,'{task,taskId}',to_jsonb('candidate-'||lpad(n::text,4,'0')))
        FROM generate_series(1,501)n`,
          [...keys, JSON.stringify(snapshot)],
        );
      },
      scope,
    );
    const source = createPgTaskProjectionSource({ pool: fixture.pool, scope, repoId: "claimable", ownsPool: false });
    const binding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source: { kind: "node", nodeId: "node-a" } as const,
      keycloakAuthorization: {
        session: {
          provider: adapter,
          personId: "owner",
          accessToken: "token-owner",
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
        },
        center: async () => ({
          provider: adapter,
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
          accessToken: "center-token",
        }),
      },
    };
    const pages: string[][] = [];
    const result = await readClaimableTasks({
      repoId: "claimable",
      binding,
      now: "2026-10-03T12:00:00Z",
      settings: { ...INITIAL_SETTINGS_V1, fleet: { ...INITIAL_SETTINGS_V1.fleet, claim: { scope: "startable" } } },
      page: async (query) => {
        const result = await source.list(query);
        pages.push(result.rows.map(({ taskId }) => taskId));
        return result;
      },
      readAssignments: async () => [
        {
          sourceRef: "task/candidate-0501",
          targetRef: "node/node-a",
          relationType: "assigned-to",
          state: "active",
          rationale: assignmentRationale("2026-10-04T12:00:00Z"),
        },
      ],
    });
    assert.deepEqual(
      pages.map((page) => page.length),
      [500, 1],
    );
    assert.equal(result.tasks.length, 50);
    assert.equal(result.tasks[0]!.taskId, "candidate-0501");
    assert.equal(result.tasks[1]!.taskId, "candidate-0001");
  } finally {
    await fixture.pool.end();
    await fixture.close();
    await realm.close();
  }
});

if (process.env.FLEET_STRESS_G38_P1 === "1") {
  test("G38 P1 original-scale production probes, first and warm", { timeout: 1_200_000 }, async () => {
    assert.ok(Number(process.versions.node.split(".")[0]) >= 26, "G38 PGlite requires Node 26");
    const { measureReadScale } = await import("./fixtures/g38-read-cost.mjs");
    const groups = {
      "task-history": [
        "agenda",
        "claimable-tasks",
        "cli-doctor-health",
        "cli-graph",
        "cli-work-list",
        "cli-work-show",
        "in-flight-work",
        "repo.works.briefs.read",
        "repo.works.index",
        "repo.workspace.scope.read",
        "task-list",
      ],
      "runtime-sessions": [
        "agenda",
        "cli-task-list",
        "cli-work-list",
        "repo.works.briefs.read",
        "repo.works.index",
        "repo.workspace.scope.read",
      ],
      dispatches: [
        "agenda",
        "cli-task-list",
        "cli-work-list",
        "repo.works.briefs.read",
        "repo.works.index",
        "repo.workspace.scope.read",
      ],
      relations: ["repo.workspace.scope.read"],
    };
    for (const [dimension, probeIds] of Object.entries(groups))
      for (const size of [200, 2000]) {
        const measured = await measureReadScale("pglite", dimension, size, { probeIds });
        process.stdout.write(
          `G38_P1_ORIGINAL ${JSON.stringify({ node: process.versions.node, dimension, size, measured })}\n`,
        );
      }
  });
}
