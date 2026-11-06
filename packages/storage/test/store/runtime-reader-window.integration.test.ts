// harness-test-tier: integration
import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { withTempStoreAsync } from "./helpers.ts";
import { createProjectionTables, REPOSITORY_READ_TABLES_SQL } from "../../src/projection/projection-tables.ts";
import { repositoryEventQueries } from "../../src/projection/repository-event-queries.ts";
import { ensureRuntimeMemberIndex, backfillRuntimeReadIndexPage } from "../../src/projection/runtime-member-index.ts";
import { ensureRuntimeMemberIndex as ensurePrevious } from "./previous-runtime-reader/runtime-member-index.fixture.ts";
import { repositoryEventQueries as previousQueries } from "./previous-runtime-reader/repository-event-queries.fixture.ts";
import { countSqliteWork } from "./sqlite-work-counter.fixture.ts";

function insertDispatch(db: DatabaseSync, revision: number): void {
  db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)").run(
    `dispatch-${revision}`,
    revision,
    JSON.stringify({
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      eventId: `event-${revision}`,
      opId: `dispatch-${revision}`,
      workspaceRevision: revision,
      actor: { principal: { personId: "fixture" }, executor: null },
      source: "local",
      occurredAt: "2026-11-05T00:00:00.000Z",
      payload: {
        dispatchId: `dispatch-${revision}`,
        runtimeSessionId: "session",
        agentId: "agent",
        startedAt: "2026-11-05T00:00:00.000Z",
        idempotencyKey: `key-${revision}`,
      },
    }),
  );
}

async function withPreviousSnapshot(db: DatabaseSync, check: (q: ReturnType<typeof previousQueries>) => void) {
  await withTempStoreAsync(async (root) => {
    const file = path.join(root, "projection.sqlite");
    // The same native backup boundary as fleet-basebackup-worker. The old query implementation
    // reads a real readonly connection, never the current query implementation or a SQL imitation.
    await backup(db, file);
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      check(previousQueries((read) => read(reader, { status: "ready", watermark: 0, sourceRevision: 0 })));
    } finally {
      reader.close();
    }
  });
}

test("frozen previous reader accepts its previous writer's physical snapshot", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    ensurePrevious(db);
    insertDispatch(db, 1);
    const current = repositoryEventQueries((read) => read(db, { status: "ready", watermark: 1, sourceRevision: 1 }));
    assert.equal(current.readRuntimeDispatchById("dispatch-1")?.event.payload.dispatchId, "dispatch-1");
    assert.throws(() => current.readRuntimeDispatchByDispatchKey("key-1"), { code: "projection_pending" });
    await withPreviousSnapshot(db, (q) => {
      assert.equal(q.readRuntimeDispatchByDispatchKey("key-1")?.event.payload.dispatchId, "dispatch-1");
      assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).rows.length, 1);
    });
  } finally {
    db.close();
  }
});

test("previous readonly reader accepts a fresh current writer's snapshot", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    ensureRuntimeMemberIndex(db);
    insertDispatch(db, 1);
    await withPreviousSnapshot(db, (q) => {
      assert.equal(q.readRuntimeDispatchByDispatchKey("key-1")?.event.payload.dispatchId, "dispatch-1");
      assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).rows.length, 1);
    });
  } finally {
    db.close();
  }
});

test("previous readonly reader retains new writes after a current writer upgrades its cache", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    ensurePrevious(db);
    insertDispatch(db, 1);
    ensureRuntimeMemberIndex(db);
    insertDispatch(db, 2);
    await withPreviousSnapshot(db, (q) => {
      assert.equal(q.readRuntimeDispatchByDispatchKey("key-1")?.event.payload.dispatchId, "dispatch-1");
      assert.equal(q.readRuntimeDispatchByDispatchKey("key-2")?.event.payload.dispatchId, "dispatch-2");
    });
  } finally {
    db.close();
  }
});

test("previous readonly member sessions follow current writer session insertion and deletion", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    ensurePrevious(db);
    insertDispatch(db, 1);
    ensureRuntimeMemberIndex(db);
    db.exec("INSERT INTO runtime_session VALUES('session',1,'{}','')");
    await withPreviousSnapshot(db, (q) =>
      assert.deepEqual(
        q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).sessions.map((s) => s.runtimeSessionId),
        ["session"],
      ),
    );
    db.exec("DELETE FROM runtime_session");
    await withPreviousSnapshot(db, (q) =>
      assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).sessions.length, 0),
    );
  } finally {
    db.close();
  }
});

test("a populated cache without the old schema becomes readable after bounded background pages", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    for (let revision = 1; revision <= 129; revision++) insertDispatch(db, revision);
    ensureRuntimeMemberIndex(db);
    const pages = [];
    for (;;) {
      const page = backfillRuntimeReadIndexPage(db);
      pages.push(page.processed);
      if (page.done) break;
    }
    assert.deepEqual(
      pages.filter((n) => n > 0),
      [64, 64, 1],
    );
    assert.ok(pages.filter((n) => n === 0).length > 1, "physical builds run after row pages");
    await withPreviousSnapshot(db, (q) => {
      assert.equal(q.readRuntimeDispatchByDispatchKey("key-129")?.event.payload.dispatchId, "dispatch-129");
      assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).rows.length, 10);
    });
  } finally {
    db.close();
  }
});

test("reopening a cache with retired legacy writers repairs stale non-null session presence", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    ensureRuntimeMemberIndex(db);
    insertDispatch(db, 1);
    db.exec("INSERT INTO runtime_session VALUES('session',1,'{}','')");
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'runtime_dispatch_%'")
      .all())
      db.exec(`DROP TRIGGER ${row.name}`);
    db.exec("DELETE FROM runtime_session");
    assert.equal(db.prepare("SELECT runtime_session_present FROM event_index").get()!.runtime_session_present, 1);
    ensureRuntimeMemberIndex(db);
    assert.equal(db.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 0);
    while (!backfillRuntimeReadIndexPage(db).done) {
      /* synchronous page control in this small fixture */
    }
    await withPreviousSnapshot(db, (q) => {
      assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).sessions.length, 0);
      assert.equal(q.readRuntimeDispatchByDispatchKey("key-1")?.event.payload.dispatchId, "dispatch-1");
    });
  } finally {
    db.close();
  }
});

test("legacy indexes resume on the original table and roll back an interrupted physical build", async (t) => {
  await withTempStoreAsync(async (root) => {
    const file = path.join(root, "projection.sqlite");
    let db = new DatabaseSync(file);
    try {
      db.exec(REPOSITORY_READ_TABLES_SQL);
      for (let revision = 1; revision <= 129; revision++) insertDispatch(db, revision);
      ensureRuntimeMemberIndex(db);
      assert.deepEqual(backfillRuntimeReadIndexPage(db), { processed: 64, done: false });
      db.exec(
        "UPDATE event_index SET event_json=json_set(event_json,'$.payload.idempotencyKey','key-updated') WHERE workspace_revision=1",
      );
      db.exec("UPDATE event_index SET task_id='parent-task' WHERE workspace_revision=1");
      db.exec("DELETE FROM event_index WHERE workspace_revision=2");
      insertDispatch(db, 130);
      db.exec("INSERT INTO runtime_session VALUES('session',1,'{}','')");
      db.close();
      db = new DatabaseSync(file);
      const work = countSqliteWork(t);
      try {
        ensureRuntimeMemberIndex(db);
        assert.equal(work.totals("attach").indexInputRows, 0, "resume must reuse every partially filled B-tree");
      } finally {
        work.stop();
      }
      assert.equal(db.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 64);
      const insert = db.prepare(
        "INSERT INTO event_index(op_id,workspace_revision,event_json) SELECT 'after-cut',131,json_set(event_json,'$.opId','after-cut','$.payload.dispatchId','after-cut','$.payload.idempotencyKey','after-cut') FROM event_index WHERE workspace_revision=1",
      );
      assert.equal(backfillRuntimeReadIndexPage(db).processed, 64);
      assert.equal(backfillRuntimeReadIndexPage(db).processed, 2);
      const originalRoot = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='event_index'").get()!.rootpage;
      let inject = true;
      const prepare = db.prepare,
        fault = t.mock.method(db, "prepare", function (sql: string) {
          const statement = Reflect.apply(prepare, db, [sql]);
          if (sql.startsWith("CREATE INDEX IF NOT EXISTS event_index_runtime_"))
            return new Proxy(statement, {
              get(target, key) {
                if (key === "run")
                  return () => {
                    const result = target.run();
                    if (inject) {
                      inject = false;
                      throw new Error("injected physical build failure");
                    }
                    return result;
                  };
                return Reflect.get(target, key);
              },
            });
          return statement;
        });
      try {
        assert.throws(() => backfillRuntimeReadIndexPage(db), /injected physical build failure/u);
      } finally {
        fault.mock.restore();
      }
      assert.equal(db.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 0);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='event_index'").get());
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='event_index_runtime_member_pending'").get(),
        undefined,
      );
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_event_index_retired'").get(), undefined);
      while (!backfillRuntimeReadIndexPage(db).done) {
        /* complete one physical tree per turn */
      }
      assert.equal(
        db.prepare("SELECT rootpage FROM sqlite_master WHERE name='event_index'").get()!.rootpage,
        originalRoot,
      );
      const reopen = countSqliteWork(t);
      try {
        createProjectionTables(db);
        assert.equal(
          reopen.totals("attach").indexInputRows,
          0,
          "the full constructor must reuse active equivalent indexes after physical build",
        );
      } finally {
        reopen.stop();
      }
      // A statement prepared before the physical builds still addresses the same original table.
      insert.run();
      const current = repositoryEventQueries((read) =>
        read(db, { status: "ready", watermark: 131, sourceRevision: 131 }),
      );
      assert.equal(current.readRuntimeDispatchByDispatchKey("after-cut")?.event.payload.dispatchId, "after-cut");
      assert.equal(
        db.prepare("SELECT task_id FROM event_index WHERE workspace_revision=1").get()!.task_id,
        "parent-task",
      );
      await withPreviousSnapshot(db, (q) => {
        assert.equal(q.readRuntimeDispatchByDispatchKey("key-updated")?.event.payload.dispatchId, "dispatch-1");
        assert.equal(q.readRuntimeDispatchByDispatchKey("key-2"), null);
        assert.equal(q.readRuntimeDispatchByDispatchKey("key-130")?.event.payload.dispatchId, "dispatch-130");
        assert.equal(q.readRuntimeDispatchByDispatchKey("after-cut")?.event.payload.dispatchId, "after-cut");
        assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 500 }).rows.length, 130);
        assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 500 }).sessions.length, 1);
      });
    } finally {
      db.close();
    }
  });
});
