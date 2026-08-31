// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  attributionFixture,
  hierarchyFixture,
  illegalRelationFixture,
  legacyRelationCanonicalCollisionFixture,
  initRepo,
  legacyRelationTypeFixture,
  orphanEndpointFixture,
  sources,
  sourcesWithoutProjection,
} from "./migration-import.fixtures.ts";
test("task hierarchy and task-side relations replay into the event stream", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-hierarchy-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    hierarchyFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-hierarchy-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const dryRun = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun));
    assert.match(String(dryRun.summary), /\| task \| 2 \| 0 \| 2 \| 2 \| PASS \|/u);
    assert.match(String(dryRun.summary), /\| relation \| 1 \| 0 \| 1 \| 1 \| PASS \|/u);

    const applied = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    const events = makeTaskEventStore({
      repoId: "migration-hierarchy-target",
      rootDir: destination,
    })
      .read()
      .events.filter((event) => event.schema === "migration-import-event/v1");
    const child = events.find(
      (event) => event.payload.entity.kind === "task" && event.payload.entity.task.taskId === "task_child",
    )!;
    assert.equal(
      (
        child.payload.entity as {
          readonly task: {
            readonly metadata?: { readonly parentTaskId?: string | null };
          };
        }
      ).task.metadata?.parentTaskId,
      "task_parent",
      "child task must carry its parent binding in the event payload",
    );
    const relations = events
      .filter((event) => event.payload.entity.kind === "relation")
      .map(
        (event) =>
          (
            event.payload.entity as {
              readonly relation: {
                readonly source: string;
                readonly target: string;
                readonly type: string;
              };
            }
          ).relation,
      );
    assert.deepEqual(
      relations.map(({ source: from, target, type }) => `${from} ${type} ${target}`),
      ["task/task_child depends-on task/task_parent"],
    );

    const rows = (await cell.read("repo.tasks.list")).rows;
    assert.equal(rows.find(({ taskId }) => taskId === "task_child")!.placement.parentTaskId, "task_parent");
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("each ratified legacy relation type replays canonically and reruns idempotently", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-relation-types-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    normalizedTypes = new Map([
      ["decision/dec_F2_ACCEPT_RECKON/C1|fact/F-HKPMAP7K", "evidenced-by"],
      ["decision/dec_F2_ACCEPT_RECKON/CH1|task/task_01KWPY434ZHW6ADS2TBC1N8TX6", "derives"],
      ["decision/dec_M5_E76_CLI_AGENT_ERGONOMICS/C1|fact/F-96WCR25Q", "evidenced-by"],
      ["decision/dec_VERT_DECISION_CONFORMANCE_PRESET/CH1|task/task_01KWMC7H04ZRY0VZ5MRR6M4XVQ", "relates"],
    ]);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    legacyRelationTypeFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-relation-type-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-31T00:00:00.000Z",
    });
    const sourceRoots = sourcesWithoutProjection(source),
      applied = (await cell.run({ kind: "migrate-import", sourceRoots }, { actor, source: "local" })) as Record<
        string,
        unknown
      >;
    assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    const store = makeTaskEventStore({
        repoId: "migration-relation-type-target",
        rootDir: destination,
      }),
      first = store.read(),
      relations = first.events.filter(
        (event) =>
          event.schema === "migration-import-event/v1" &&
          event.payload.entity.kind === "relation" &&
          normalizedTypes.has(`${event.payload.entity.relation.source}|${event.payload.entity.relation.target}`),
      );
    assert.equal(relations.length, 4);
    for (const event of relations) {
      if (event.schema !== "migration-import-event/v1" || event.payload.entity.kind !== "relation") continue;
      const record = event.payload.entity.relation,
        expectedType = normalizedTypes.get(`${record.source}|${record.target}`)!;
      assert.equal(record.type, expectedType, `${record.source}|${record.target}`);
      assert.equal(
        record.relation_id,
        deriveRelationId({
          source: record.source,
          target: record.target,
          type: expectedType as typeof record.type,
          direction: record.direction,
        }),
      );
    }

    const rerun = (await cell.run({ kind: "migrate-import", sourceRoots }, { actor, source: "local" })) as Record<
        string,
        unknown
      >,
      second = store.read();
    assert.equal(rerun.exitCode, 0, JSON.stringify(rerun));
    assert.equal(second.head?.revision, first.head?.revision);
    assert.equal(second.events.length, first.events.length);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a canonical relation snapshot wins over its later retired legacy alias", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-relation-collision-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    legacyRelationCanonicalCollisionFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-relation-collision-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-31T00:00:00.000Z",
    });
    const applied = (await cell.run(
      { kind: "migrate-import", sourceRoots: sourcesWithoutProjection(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    const events = makeTaskEventStore({
        repoId: "migration-relation-collision-target",
        rootDir: destination,
      }).read().events,
      matching = events.filter(
        (event) =>
          event.schema === "migration-import-event/v1" &&
          event.payload.entity.kind === "relation" &&
          event.payload.entity.relation.source === "decision/dec_VERT_DECISION_CONFORMANCE_PRESET/CH1" &&
          event.payload.entity.relation.target === "task/task_01KWMC7H04ZRY0VZ5MRR6M4XVQ",
      );
    assert.equal(matching.length, 1);
    const relation = matching[0];
    assert.equal(relation?.schema, "migration-import-event/v1");
    if (relation?.schema !== "migration-import-event/v1" || relation.payload.entity.kind !== "relation") return;
    assert.equal(relation.payload.entity.relation.type, "relates");
    assert.equal(relation.payload.entity.relation.state, "active");
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("unmapped legacy relation triples fail the row into the manual table", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-illegal-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    illegalRelationFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-illegal-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const dryRun = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun));
    assert.match(String(dryRun.summary), /\| relation \| 2 \| 1 \| 2 \| 2 \| PASS \|/u);
    assert.match(String(dryRun.summary), /Format observations: 1 legacy parser observations/u);
    assert.match(
      String(dryRun.summary),
      /\| relation \| rel_[a-f0-9]{16} \| FAIL \| .* \| manual adjudication required:/u,
    );
    assert.match(String(dryRun.summary), /no deterministic legacy mapping for decision --blocks--> fact/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a relation whose endpoint has no same-cut witness is retired with a receipt disposition", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-orphan-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    orphanEndpointFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-orphan-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const dryRun = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun));
    assert.deepEqual((dryRun.reconciliation as Record<string, unknown>).relation, {
      source: 1,
      target: 1,
      difference: 1,
      derived: 0,
      archived: 0,
      retired: 1,
      missingIds: [],
      passed: true,
    });
    assert.deepEqual(
      (dryRun.dispositions as readonly Record<string, unknown>[]).filter(({ entityType }) => entityType === "relation"),
      [
        {
          entityType: "relation",
          entityId: "rel_ab6e554f2a225df1",
          sourcePath: "harness/tasks/task_good/INDEX.md",
          disposition: "retired",
          reason: "truth_gap",
        },
      ],
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migrated entities keep the actor recorded in the source repository, not the importer", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-attribution-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    attributionFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-attribution-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const applied = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    // task_owned has an attribution record; task_unowned has none and falls back to the importer.
    // Both must be non-zero, otherwise the index is either ignored or applied blindly.
    assert.match(
      String(applied.summary),
      /Attribution: principal restored from source records for [1-9]\d* entities, [1-9]\d* fell back/u,
      String(applied.summary),
    );
    assert.match(String(applied.summary), /\| source-authority-attribution \| excluded \| 1 \| PASS \|/u);
    const events = makeTaskEventStore({
      repoId: "migration-attribution-target",
      rootDir: destination,
    })
      .read()
      .events.filter((event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "task");
    const seen = Object.fromEntries(
      events.map((event) => [
        (event.payload.entity as { readonly task: { readonly taskId: string } }).task.taskId,
        event.actor,
      ]),
    );
    // The person is the one the source recorded; the executor is whoever ran this import.
    assert.deepEqual(seen.task_owned, {
      principal: { personId: "person_original" },
      executor: { kind: "agent", id: "codex" },
    });
    assert.deepEqual(seen.task_unowned, actor);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
