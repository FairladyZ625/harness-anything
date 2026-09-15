// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

const binding = { actor, source: "local" as const };

async function withCell(name: string, run: (cell: Cell) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-${name}-`));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId(name),
      rootDir: canonicalRoot(rootDir),
      ownerId: name,
      now: () => "2026-09-10T03:00:00.000Z",
    });
    await run(cell);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function rows(cell: Cell, action: Record<string, unknown>): Promise<readonly Record<string, unknown>[]> {
  const payload = evidence(await cell.run({ kind: "event-list", ...action }, binding));
  assert.equal(payload.schema, "event-list/v1");
  return payload.rows as readonly Record<string, unknown>[];
}

test("event list filters by type and actor against the canonical event table", async () => {
  await withCell("event-query-filter", async (cell) => {
    for (const taskId of ["task_alpha", "task_beta"])
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
    const settingsRows = await rows(cell, { type: "settings_changed" });
    assert.ok(settingsRows.length >= 1);
    for (const row of settingsRows) assert.equal(row.type, "settings_changed");
    const taskRows = await rows(cell, { type: "task_bootstrapped" });
    assert.ok(taskRows.length >= 2);
    const actorRows = await rows(cell, { actor: "person-surface" });
    assert.ok(actorRows.length >= 2);
    for (const row of actorRows) assert.equal((row.actor as Record<string, unknown>).personId, "person-surface");
    const fixtureRows = await rows(cell, { actor: "fixture" });
    assert.ok(fixtureRows.length >= 1);
    for (const row of fixtureRows) assert.notEqual((row.actor as Record<string, unknown>).personId, "person-surface");
    const entityRows = await rows(cell, { entity: "task/task_alpha" });
    assert.ok(entityRows.length >= 1);
    for (const row of entityRows) assert.ok((row.entityRefs as readonly string[]).includes("task/task_alpha"));
  });
});

test("event list pages by revision-descending cursor without overlap", async () => {
  await withCell("event-query-page", async (cell) => {
    for (const taskId of ["task_p1", "task_p2", "task_p3"])
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
    const first = evidence(await cell.run({ kind: "event-list", limit: 2 }, binding));
    assert.equal((first.rows as unknown[]).length, 2);
    assert.equal(typeof (first.page as Record<string, unknown>).nextCursor, "string");
    const revisions: number[] = [],
      seen = new Set<number>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const payload = evidence(
          await cell.run({ kind: "event-list", limit: 2, ...(cursor ? { cursor } : {}) }, binding),
        ),
        pageRows = payload.rows as readonly { revision: number }[];
      for (const row of pageRows) {
        assert.ok(!seen.has(row.revision), `revision ${row.revision} appeared twice`);
        seen.add(row.revision);
        revisions.push(row.revision);
      }
      const next = (payload.page as Record<string, unknown>).nextCursor as string | null;
      if (next === null) break;
      cursor = next;
    }
    assert.ok(revisions.length >= 5);
    assert.deepEqual(
      revisions,
      [...revisions].sort((a, b) => b - a),
    );
  });
});

test("event show returns the complete original event JSON by op id and event id", async () => {
  await withCell("event-query-show", async (cell) => {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task_show", title: "Show me" }, binding)).outcome,
      "applied",
    );
    const listed = await rows(cell, { entity: "task_show", limit: 1 }),
      opId = String(listed[0]!.opId),
      eventId = String(listed[0]!.eventId),
      byOp = evidence(await cell.run({ kind: "event-show", opId }, binding)),
      byEventId = evidence(await cell.run({ kind: "event-show", opId: eventId }, binding));
    assert.equal(byOp.schema, "event-show/v1");
    const event = byOp.event as Record<string, unknown>;
    assert.equal(event.opId, opId);
    assert.equal(event.eventId, eventId);
    for (const field of ["schema", "type", "actor", "source", "occurredAt", "payload", "workspaceRevision"])
      assert.ok(Object.hasOwn(event, field), `event JSON is missing ${field}`);
    assert.deepEqual(byEventId.event, event);
    const missing = await cell.run({ kind: "event-show", opId: "op-nope" }, binding);
    assert.equal(missing.outcome, "op_rejected");
  });
});
