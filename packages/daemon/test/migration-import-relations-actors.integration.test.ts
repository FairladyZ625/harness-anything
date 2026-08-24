// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

import {
  actor,
  attributionFixture,
  hierarchyFixture,
  illegalRelationFixture,
  initRepo,
  orphanEndpointFixture,
  sources,
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
    assert.match(
      String(dryRun.summary),
      /\| task \| 2 \| 0 \| 2 \| 2 \| PASS \|/u,
    );
    assert.match(
      String(dryRun.summary),
      /\| relation \| 1 \| 0 \| 1 \| 1 \| PASS \|/u,
    );

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
      (event) =>
        event.payload.entity.kind === "task" &&
        event.payload.entity.task.taskId === "task_child",
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
      relations.map(
        ({ source: from, target, type }) => `${from} ${type} ${target}`,
      ),
      ["task/task_child depends-on task/task_parent"],
    );

    const rows = (await cell.read("repo.tasks.list")).rows;
    assert.equal(
      rows.find(({ taskId }) => taskId === "task_child")!.placement
        .parentTaskId,
      "task_parent",
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("relations the current matrix rejects are skipped with a reason instead of migrating", async () => {
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
    assert.equal(dryRun.exitCode, 3, JSON.stringify(dryRun));
    assert.match(
      String(dryRun.summary),
      /\| relation \| 2 \| 1 \| 1 \| 1 \| PASS \|/u,
    );
    assert.match(String(dryRun.summary), /Format validation: 1 skipped/u);
    assert.match(
      String(dryRun.summary),
      /type supports is not allowed for decision->fact/u,
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a relation whose endpoint entity never migrates is reported, not dropped in silence", async () => {
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
    // old counts the edge, and it cannot be produced because its endpoint task is skipped.
    // Either it is accounted for as a skip, or the reconciliation must fail — never a silent drop.
    assert.match(
      String(dryRun.summary),
      /\| relation \| 1 \| 1 \| 0 \| 0 \| PASS \|/u,
      String(dryRun.summary),
    );
    assert.match(
      String(dryRun.summary),
      /SKIP relation/u,
      String(dryRun.summary),
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
    assert.match(
      String(applied.summary),
      /\| source-authority-attribution \| excluded \| 1 \| PASS \|/u,
    );
    const events = makeTaskEventStore({
      repoId: "migration-attribution-target",
      rootDir: destination,
    })
      .read()
      .events.filter(
        (event) =>
          event.schema === "migration-import-event/v1" &&
          event.payload.entity.kind === "task",
      );
    const seen = Object.fromEntries(
      events.map((event) => [
        (event.payload.entity as { readonly task: { readonly taskId: string } })
          .task.taskId,
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
