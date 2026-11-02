// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { serializeCanonicalEventUnchecked } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { compileEntityUpsert } from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { createPgTaskQueryReader } from "../../src/pg/pg-task-query-reader.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { memoryEventStore, reviewEvents } from "../store/task-owned-entity-projection.fixtures.ts";
import { legacyAgentCommand } from "../store/legacy-agent-declaration.fixture.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import {
  historicalEventQueryFixtures,
  historicalEventQueryContract,
  retiredCiQueryFixtures,
} from "./pg-task-event-parity.fixture.ts";

test("PG query edge inputs retain the SQLite contract", async (t) => {
  const fixture = await startManagedPostgresFixture(),
    pool = fixture.adminPool;
  try {
    await withPostgresTransaction(pool, async (client) => {
      for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(statement);
      await ensurePgProjectionSchema(client);
    });
    const scope = { tenantId: "edges", projectId: "edges", policyEpoch: 1, readers: ["visible"] },
      repoId = "edge-parity",
      connectionString = `postgres://postgres@127.0.0.1:${fixture.port}/postgres`;
    const replay = async (events: readonly CanonicalEventV1[], blobs = new Map<string, Uint8Array>()) => {
      await withPostgresTransaction(
        pool,
        async (client) => {
          await rebuildPgProjection(client, scope, { events, readContentBlob: (sha) => blobs.get(sha) ?? null });
          await client.query(
            `INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,policy_epoch,readers,revision,head_op_id,head_event_digest,head_digest)
           VALUES($1,$2,$3,$4,$5,$6,'fixture','fixture','fixture')
           ON CONFLICT(tenant_id,project_id,repo_id) DO UPDATE SET revision=excluded.revision`,
            [
              scope.tenantId,
              scope.projectId,
              repoId,
              scope.policyEpoch,
              scope.readers,
              events.at(-1)!.workspaceRevision,
            ],
          );
        },
        scope,
      );
    };

    const seedEventHistory = async (events: readonly CanonicalEventV1[]) => {
      await withPostgresTransaction(pool, async (client) => {
        await client.query("DELETE FROM ha_events");
        for (const event of events) {
          const body = serializeCanonicalEventUnchecked(event).trimEnd();
          await client.query(
            `INSERT INTO ha_events(tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at,policy_epoch,readers)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              scope.tenantId,
              scope.projectId,
              repoId,
              event.workspaceRevision,
              event.opId,
              event.eventId,
              event.type,
              body,
              `sha256:${sha256Text(body)}`,
              event.occurredAt,
              scope.policyEpoch,
              scope.readers,
            ],
          );
        }
      });
    };

    await t.test("historical task, schedule, settings and vertical outputs retain accepted fields", async (t) => {
      const fixture = historicalEventQueryFixtures();
      for (let end = 1; end <= fixture.events.length; end++) {
        const events = fixture.events.slice(0, end),
          head = events.at(-1)!;
        await t.test(head.schema, async () =>
          withTempStoreAsync(async (rootDir) => {
            const sqlite = makeTaskProjection({
              rootDir,
              eventStore: {
                ...memoryEventStore(events, fixture.blobs),
                readHead: () => ({
                  revision: head.workspaceRevision,
                  eventDigest: `sha256:${sha256Text(serializeCanonicalEventUnchecked(head))}`,
                }),
              },
            });
            sqlite.catchUp();
            const expected = historicalEventQueryContract(sqlite, events);
            await replay(events, fixture.blobs);
            await seedEventHistory(events);
            const pg = createPgTaskQueryReader({ connectionString, scope, repoId });
            try {
              pg.withSession((queries) => assert.deepEqual(historicalEventQueryContract(queries, events), expected));
            } finally {
              pg.close();
              sqlite.close();
            }
          }),
        );
      }
      await pool.query("DELETE FROM ha_events");
    });

    await t.test("retired CI observations stay outside every event-index query", async () => {
      await withTempStoreAsync(async (rootDir) => {
        const retired = retiredCiQueryFixtures(),
          current = { ...lifecycleFixture({ taskId: "retired-ci-task" }).events[0]!, workspaceRevision: 2 },
          events = [
            retired[0]!,
            current,
            ...retired.slice(1).map((event, index) => ({ ...event, workspaceRevision: index + 3 })),
          ],
          head = events.at(-1)!,
          sqlite = makeTaskProjection({
            rootDir,
            eventStore: {
              ...memoryEventStore(events),
              readHead: () => ({
                revision: head.workspaceRevision,
                eventDigest: `sha256:${sha256Text(serializeCanonicalEventUnchecked(head))}`,
              }),
            },
          });
        sqlite.catchUp();
        const contract = (queries: TaskProjectionQueries) => {
          const canonical = queries.readCanonicalEvents(0, 500),
            replica = queries.readReplicaBasis(0),
            list = queries.readEventList({ limit: 1 }),
            summaries = queries.readEventSummaries(0, 1),
            skipped = events.filter(({ type }) => type === "ci_run_observed"),
            operations = skipped.map(({ opId }) => queries.readOperation(opId)),
            witnesses = skipped.map(({ workspaceRevision }) => queries.readEventWitness(workspaceRevision));
          assert.deepEqual(canonical.events, [current]);
          assert.deepEqual(
            queries.readCanonicalEvents(0, 1).events,
            [current],
            "filter retired rows before page limit",
          );
          assert.deepEqual(queries.readCanonicalEvents(2, 1).events, []);
          assert.deepEqual(replica.events, [current]);
          assert.equal(replica.headEvent, null);
          assert.equal(list.rows.length, 1);
          assert.equal(summaries.events.length, 1);
          assert.deepEqual(operations, [null, null, null, null]);
          assert.deepEqual(witnesses, [null, null, null, null]);
          return { canonical, replica, list, summaries, operations, witnesses };
        };
        const expected = contract(sqlite);
        await replay(events);
        await seedEventHistory(events);
        const pg = createPgTaskQueryReader({ connectionString, scope, repoId });
        try {
          pg.withSession((queries) => assert.deepEqual(contract(queries), expected));
        } finally {
          pg.close();
          sqlite.close();
        }
      });
      await pool.query("DELETE FROM ha_events");
    });

    await t.test("owned review and execution witnesses include colliding local ids", async () => {
      await withTempStoreAsync(async (rootDir) => {
        const events = reviewEvents("review-shared", "execution-shared"),
          sqlite = makeTaskProjection({ rootDir, eventStore: memoryEventStore(events) });
        sqlite.catchUp();
        await replay(events);
        const pg = createPgTaskQueryReader({ connectionString, scope, repoId });
        const contract = (queries: TaskProjectionQueries) => {
          const refs = ["review/review-shared", "execution/execution-shared", "review/missing"];
          assert.equal(queries.readEntityVersionWitness(refs[0]!).freshness, "current");
          assert.equal(queries.readEntityVersionWitness(refs[1]!).freshness, "current");
          return {
            witnesses: refs.map((ref) => queries.readEntityVersionWitness(ref)),
            reviews: queries.listEntities("review"),
            executions: queries.listEntities("execution"),
          };
        };
        try {
          pg.withSession((queries) => assert.deepEqual(contract(queries), contract(sqlite)));
        } finally {
          pg.close();
          sqlite.close();
        }
      });
    });

    await t.test("unpaged list and index include 4097 tasks; index ignores pinnedFirst", async () => {
      await withTempStoreAsync(async (rootDir) => {
        const seed = lifecycleFixture({ taskId: "task-seed" }).events[0]!,
          events = Array.from({ length: 4097 }, (_, index) => {
            assert.equal(seed.type, "task_created");
            const taskId = `task-${String(index).padStart(4, "0")}`;
            return {
              ...seed,
              eventId: taskId,
              opId: taskId,
              taskId,
              workspaceRevision: index + 1,
              payload: { ...seed.payload, task: { ...seed.payload.task, taskId, pinned: index === 4096 } },
            };
          }),
          sqlite = makeTaskProjection({ rootDir, eventStore: memoryEventStore(events) });
        sqlite.catchUp();
        await replay([events[0]!]);
        // Populate the large read model in bulk; query semantics, rather than replay speed, are under test.
        const rows = sqlite.list().rows;
        assert.equal(rows.length, 4097);
        await pool.query(`DELETE FROM ha_task_snapshots WHERE tenant_id=$1`, [scope.tenantId]);
        await pool.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,readers,task_id,workspace_revision,snapshot,package_path,generation,created_at,completed_at,updated_at)
          SELECT $1,$2,$3,$4,x->>'taskId',(x->>'workspaceRevision')::bigint,x->'snapshot',x->>'packagePath',x->>'generation',(x->>'createdAt')::timestamptz,(x->>'completedAt')::timestamptz,(x->>'updatedAt')::timestamptz FROM jsonb_array_elements($5::jsonb) x`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, scope.readers, JSON.stringify(rows)],
        );
        await pool.query("UPDATE ha_projection_meta SET watermark=4097,source_revision=4097 WHERE tenant_id=$1", [
          scope.tenantId,
        ]);
        await pool.query("UPDATE ha_repo_heads SET revision=4097 WHERE tenant_id=$1", [scope.tenantId]);
        const pg = createPgTaskQueryReader({ connectionString, scope, repoId });
        const contract = (queries: TaskProjectionQueries) => {
          const list = queries.list(),
            index = queries.readTaskIndex();
          assert.equal(list.rows.length, 4097);
          assert.equal(index.rows.length, 4097);
          assert.equal(list.page, undefined);
          assert.equal(index.page, null);
          const first = queries.readTaskIndex({ limit: 1, pinnedFirst: true }),
            next = queries.readTaskIndex({ limit: 1, pinnedFirst: true, cursor: first.page!.nextCursor! });
          assert.equal(first.rows[0]!.taskId, "task-0000");
          const pages = [];
          let cursor: string | undefined;
          do {
            const page = queries.readTaskIndex({ limit: 500, pinnedFirst: true, ...(cursor ? { cursor } : {}) });
            pages.push(page);
            const nextCursor = page.page!.nextCursor;
            assert.notEqual(nextCursor, cursor);
            cursor = nextCursor ?? undefined;
          } while (cursor !== undefined);
          assert.deepEqual(
            pages.flatMap((page) => page.rows),
            index.rows,
          );
          return {
            pages,
            list,
            index,
            first,
            next,
            pinned: queries.list({ limit: 1, pinnedFirst: true }),
            last: queries.readTaskIndex({ taskIds: ["task-4096"], limit: 1 }),
            empty: queries.readTaskIndex({ taskIds: [], limit: 1 }),
          };
        };
        try {
          pg.withSession((queries) => assert.deepEqual(contract(queries), contract(sqlite)));
        } finally {
          pg.close();
          sqlite.close();
        }
      });
    });

    await t.test(
      "historical declaration replay degrades one row, preserves documents and restores on reinstall",
      async () => {
        await withTempStoreAsync(async (rootDir) => {
          const legacy = legacyAgentCommand("legacy", "legacy-worker", 1),
            current = compileEntityUpsert({
              eventId: "current",
              opId: "current",
              workspaceRevision: 2,
              actor: { principal: { personId: "person_synthetic" }, executor: null },
              source: "local",
              occurredAt: "2026-09-18T00:10:00.000Z",
              entityKind: "agent",
              entity: {
                schema: "agent-declaration/v1",
                id: "current-worker",
                name: "Current",
                instructions: "Work",
                runtimes: [{ type: "codex" }],
              },
            }),
            events: CanonicalEventV1[] = [...legacy.events, current.event],
            blobs = new Map([...legacy.blobs, ...current.blobs].map((blob) => [blob.sha256, Buffer.from(blob.body)])),
            eventStore = memoryEventStore(events, blobs),
            sqlite = makeTaskProjection({ rootDir, eventStore });
          sqlite.catchUp();
          const contract = (queries: TaskProjectionQueries) => {
            assert.equal(queries.getEntity("agent", "legacy-worker")?.freshness, "unknown");
            assert.equal(queries.getEntity("agent", "current-worker")?.freshness, "current");
            return {
              rows: queries.listEntities("agent"),
              document: queries.readDocument("agents/legacy-worker.json"),
              witness: queries.readEntityVersionWitness("agent/legacy-worker"),
            };
          };
          await replay(events, blobs);
          const pg = createPgTaskQueryReader({ connectionString, scope, repoId });
          try {
            pg.withSession((queries) => assert.deepEqual(contract(queries), contract(sqlite)));
          } finally {
            pg.close();
          }
          const restored = compileEntityUpsert({
            ...current.event,
            workspaceRevision: 3,
            eventId: "restored",
            opId: "restored",
            entityKind: "agent",
            entity: {
              schema: "agent-declaration/v1",
              id: "legacy-worker",
              name: "Restored",
              instructions: "Work",
              runtimes: [{ type: "codex" }],
            },
          });
          events.push(restored.event);
          for (const blob of restored.blobs) blobs.set(blob.sha256, Buffer.from(blob.body));
          sqlite.catchUp();
          await replay(events, blobs);
          const source = createPgTaskProjectionSource({ pool, scope, repoId });
          assert.deepEqual(
            await source.getEntity("agent", "legacy-worker"),
            sqlite.getEntity("agent", "legacy-worker"),
          );
          assert.equal((await source.getEntity("agent", "legacy-worker"))?.freshness, "current");
          sqlite.close();
          // Inject corrupt blob reads after the verified event envelope; the declaration keeps its valid claim.
          const sha = current.blobs[0]!.sha256,
            size = Buffer.byteLength(current.blobs[0]!.body),
            wrongIdentity = Buffer.from(
              Buffer.from(current.blobs[0]!.body).toString().replaceAll("current-worker", "corrupt-worker"),
            );
          assert.equal(wrongIdentity.byteLength, size);
          const corruptions = [
            { event: current.event, content: new Map([[sha, wrongIdentity]]), error: /identity mismatch/ },
            { event: current.event, content: new Map<string, Uint8Array>(), error: /unavailable/ },
            { event: current.event, content: new Map([[sha, Buffer.alloc(size, 0xff)]]), error: /UTF-8/ },
            { event: current.event, content: new Map([[sha, Buffer.alloc(size, 0x7b)]]), error: /JSON/ },
          ];
          for (const { event, content, error } of corruptions) {
            await assert.rejects(replay([event], content), error);
            await withTempStoreAsync(async (corruptRoot) => {
              assert.throws(() => {
                const projection = makeTaskProjection({
                  rootDir: corruptRoot,
                  eventStore: memoryEventStore([event], content),
                });
                projection.catchUp();
              }, error);
            });
          }
        });
      },
    );
  } finally {
    await fixture.close();
  }
});
